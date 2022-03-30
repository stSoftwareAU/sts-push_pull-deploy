"use strict";

const AWS = require('aws-sdk');
const jwt = require('jsonwebtoken');

const GitHubClient = require('libs/GitHubClient.js').GitHubClient;
const featureIssues = require('libs/features/issues');
const featureChecks = require('libs/features/checks');
const featureInstallations = require('libs/features/installations');

const ecr = new AWS.ECR();
const sns = new AWS.SNS();
const sts = new AWS.STS();
const lambda = new AWS.Lambda();

const secretsManager = new AWS.SecretsManager();
const gitOrganization = process.env.gitOrganization;

const global = {area:"unknown", department:"unknown"};

// Handler
exports.handler = async function (event, context) {

  console.info("##CONTEXT", prettyPrint(context));
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    if (!event.message && event.messageB64) {
      event.message = Buffer.from(event.messageB64, 'base64').toString('ascii');
      delete event.messageB64;
    }
    console.info("##EVENT", prettyPrint(event));

    await populateImage(event);
    const body = { status: event.status, area: event.area, warnings: [] };

    const tags = await lambda.listTags({ Resource: context.invokedFunctionArn }).promise().then(data => data.Tags);

    global.area = event.area;
    global.department = tags['Department'];

    if (event.status.toLowerCase() == "ok") {
      await doOK(body, event);
    }
    else if (event.status.toLowerCase().substring(0, 5) == "start") {
      await doStart(body, event);
    }
    else {
      await doError(body, event);
    }

    return happyResponse(body);
  }
  catch (error) {
    return sadResponse(error);
  }
};

async function populateImage(event) {
  let params = {
    repositoryName: event.area.toLowerCase() + "/" + event.gitRepo,
    imageIds: [{ imageDigest: event.imageDigest }]
  };

  let data = await ecr.describeImages(params).promise();
  event.commitID = "<UNKNOWN>";
  if (data.imageDetails && data.imageDetails.length > 0) {
    let imageDetails = data.imageDetails[0];
    let tagGIT = imageDetails.imageTags.find(tag => tag.startsWith("git_"));
    if( ! tagGIT ){
      let tagUnique = imageDetails.imageTags.find(tag => tag.startsWith("ts_") && tag.includes( "-git_"));
      if( tagUnique){
        let pos = tagUnique.indexOf( "-git_");
        if( pos >0){
          tagGIT=tagUnique.substring( pos + 1);
        }
      }
    }

    if (tagGIT) {
      event.headSHA = tagGIT.substring(4);
      event.commitURL = `https://github.com/${gitOrganization}/${event.gitRepo}/commit/${event.headSHA}`;
      event.commitID = event.headSHA.substring(0, 7);
    }
    else {
      console.warn("No GIT tag", prettyPrint(imageDetails.imageTags));
    }
  } else {
    console.warn("No Image found tag", prettyPrint(params));
  }
}

function titleCase(str) {
  let splitStr = str.toLowerCase().split(' ');
  for (let i = 0; i < splitStr.length; i++) {
    // You do not need to check if i is larger than splitStr length, as your for does that for you
    // Assign it back to the array
    splitStr[i] = splitStr[i].charAt(0).toUpperCase() + splitStr[i].substring(1);
  }
  // Directly return the joined string
  return splitStr.join(' ');
}

async function sendSNS(event) {
  
  let subject = "Unknown";
  let topic = "Unknown";
  if (event.status.toLowerCase() == "ok") {
    subject = `Deployed ${event.gitRepo} to ${global.area} #${event.commitID}`;
    topic = "deploy-finished";
  }
  else if (event.status.toLowerCase().substring(0, 5) == "start") {
    subject = `Deploying ${event.gitRepo} to ${global.area} #${event.commitID}`;
    topic = "deploy-start";
  }
  else {
    subject = `${titleCase(event.status)} to deploy ${event.gitRepo} in ${global.area} #${event.commitID}`;
    topic = "deploy-error";
  }
  console.info(`SNS send: ${subject}`);
  if (!event.message) {
    console.warn("Missing message", prettyPrint(event));
    event.message = "Missing message";
  }

  const { Account: account } = await sts.getCallerIdentity().promise();

  let tmpMessage = event.message;
  if (event.commitURL) {
    tmpMessage = `Source Commit ${event.commitURL}\n\n${tmpMessage}`;
  }

  let params = {
    TopicArn: `arn:aws:sns:${AWS.config.region}:${account}:${global.department.toLowerCase()}-${topic}`,
    Subject: subject,
    Message: tmpMessage
  };

  let result = await sns.publish(params).promise();
  console.warn("SNS result", prettyPrint(result));
}

async function doOK(body, event) {
  await sendSNS(event);
  let msg = event.message;
  if (!msg) {
    msg = "Missing message";
  }

  body.msg = msg;
}

async function doStart(body, event) {
  await sendSNS(event);

  let msg = event.message;
  if (!msg) {
    msg = "Missing message";
  }

  body.msg = msg;
}

async function makeClient() {
  let jwt = await createJWT();

  let tokenClient = new GitHubClient({
    baseUri: "https://api.github.com",
    jwt: jwt
  }, featureInstallations);

  let installation = await tokenClient.listInstallations().then(
    data => data.find(item => item.account.login.toLowerCase() === gitOrganization.toLowerCase())
  );

  if (installation == null) {
    throw `No matching installaton for ${gitOrganization}`;
  }
  let accessToken = await tokenClient.createAccessToken({ installation_id: installation.id }).then(item => item.token);

  let gitClient = new GitHubClient({
    baseUri: "https://api.github.com",
    token: accessToken,
    debug: false
  }, featureIssues, featureChecks);

  gitClient.checkTOKEN();

  return gitClient;
}

async function doError(body, event) {

  await sendSNS(event);

  let gitClient = await makeClient();

  let issuesParameters = {
    owner: gitOrganization,
    repository: event.gitRepo
  };

  let issues = await gitClient.fetchIssues(issuesParameters);

  let issueTitle = `Deploy to ${titleCase(body.area)} ${titleCase(event.status)} `;

  let currentIssue = issues.find(obj => obj.state == 'open' && obj.title == issueTitle);
  let msg = event.message;
  if (!msg) {
    msg = "Missing message";
  }

  body.msg = msg;

  if (currentIssue) {
    let commentParameters = {
      owner: gitOrganization,
      repository: event.gitRepo,
      number: currentIssue.number,
      body: msg
    };

    let gitData = await gitClient.addIssueComment(commentParameters);
    body.data = gitData;
  }
  else {
    let issueParameters = {
      owner: gitOrganization,
      repository: event.gitRepo,
      title: issueTitle,
      body: msg
    };

    let gitData = await gitClient.createIssue(issueParameters);
    body.data = gitData;
  }

  if (event.headSHA) {

    let issueURL = body.data.issue_url;
    await gitClient.createCheck({
      owner: gitOrganization,
      repository: event.gitRepo,
      name: issueTitle,
      head_sha: event.headSHA,
      details_url: issueURL,
      conclusion: 'failure'
    });

  }
  else {
    body.warnings.push("No GIT tag");
  }
}

async function createJWT() {
  let params = {
    SecretId: "DEPLOY_GIT"
  };
  let secret = await secretsManager.getSecretValue(params).promise().then(e => JSON.parse(e.SecretString));

  let tmpPrivateKey = Buffer.from(secret.privateKey.replace(/ /g, ''), 'base64').toString('ascii');
  let appID = secret.appID;

  let now = new Date();
  let payLoad = {
    iss: appID,
    iat: Math.floor(now.getTime() / 1000) - 60,
    exp: Math.floor(now.getTime() / 1000) + 600
  };

  let token = jwt.sign(payLoad, tmpPrivateKey, { algorithm: 'RS256' });

  return token;
}

function happyResponse(body) {

  if (body.warnings != null && body.warnings.length > 0) {
    console.warn(prettyPrint(body));
  }
  else {
    delete body.warnings;
  }

  var response = {
    "statusCode": 200,
    "headers": {
      "Content-Type": "application/json"
    },
    "body": body
  };
  return response;
}

function sadResponse(error) {
  console.error(error);
  let errorCode = 500;
  if (Number.isInteger(error.statusCode) && error.statusCode >= 300 && error.statusCode < 600) {
    errorCode = error.statusCode;
  }
  var response = {
    "statusCode": errorCode,
    "headers": {
      "Content-Type": "text/plain",
      "x-amzn-ErrorType": errorCode
    },
    "isBase64Encoded": false,
    "body": error.code + ": " + error.message
  };
  return response;
}

function prettyPrint(object) {
  return JSON.stringify(object, null, 2);
}
