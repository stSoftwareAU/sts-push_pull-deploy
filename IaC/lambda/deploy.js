// Whole-script strict mode syntax
"use strict";
const AWS = require('aws-sdk');

const autoscaling = new AWS.AutoScaling();
const appconfig = new AWS.AppConfig();
const ecr = new AWS.ECR();
const area = process.env.AREA;
const department = process.env.DEPARTMENT;
const repoName = process.env.repoName;
const deployASG = process.env.deployASG;
const lambda = new AWS.Lambda();

const tagPrefix = "deploy.state/";

const global = {};

// Handler
exports.handler = async function handler(event, context) {

  global.invokedFunctionArn = context.invokedFunctionArn;
  // console.info( "##EVENT", prettyPrint( event));
  // console.info( "##CONTEXT", prettyPrint( context));
  context.callbackWaitsForEmptyEventLoop = false;

  try {
    const body = JSON.parse('{"deployed":[], "warnings":[]}');

    let monitor = event.monitor;
    if (!monitor) {

      let params = {};
      params.Application = repoName;
      params.ClientId = "any-id";
      params.Configuration = "config";
      params.Environment = area.toLowerCase();

      let appConfigResponse = await appconfig.getConfiguration(params).promise();

      const configData = JSON.parse(
        Buffer.from(appConfigResponse.Content, 'base64').toString('ascii')
      );

      // console.info( "##configuration", prettyPrint( configData));
      monitor = configData.monitor;
    }

    for (const item of monitor) {
      await doMonitor(body, item);
    }
    return happyResponse(body);
  }
  catch (error) {
    return sadResponse(error);
  }
};

async function doMonitor(body, item) {

  let images = await listImages(body.warnings, item.dockerRepo);

  for (const image of images) {
    await doImage(body, item, image);
  }
}

// function isBlank(str) {
//     return (!str || /^\s*$/.test(str));
// }

async function doIaC(body, item, image) {

  const a = [];
  a.push(deployASG);
  const params = {};
  params["AutoScalingGroupNames"] = a;

  const data = await autoscaling.describeAutoScalingGroups(params).promise();

  if (data.AutoScalingGroups.length != 1) {

    body.warnings.push("No deploy ASG: " + deployASG);
  } else {
    let desiredCapacity = data.AutoScalingGroups[0].DesiredCapacity;

    if (desiredCapacity == 0) {
      let tagParams = {};
      tagParams.Tags = [];

      let tag = {};
      tag.Key = tagPrefix + "DOCKER_REPO";
      tag.PropagateAtLaunch = true;
      tag.ResourceId = deployASG;
      tag.ResourceType = "auto-scaling-group";
      tag.Value = item.dockerRepo;
      tagParams.Tags.push(tag);

      await autoscaling.createOrUpdateTags(tagParams).promise();

      await autoscaling.updateAutoScalingGroup({
        DesiredCapacity: 1,
        AutoScalingGroupName: deployASG
      }).promise();

      let updateTags = {};
      updateTags.Resource = global.invokedFunctionArn;
      updateTags.Tags = {};
      let tagKey = tagPrefix + item.dockerRepo;
      updateTags.Tags[tagKey] = image.imageDigest;

      await lambda.tagResource(updateTags).promise();

      body.deployed.push(updateTags.Tags);

      let callResult=await lambda.invoke(
        {
          FunctionName: `${department.toLowerCase()}-deploy-notify`,
          Payload: JSON.stringify({
            gitRepo: item.dockerRepo,
            area: area,
            status: 'Started',
            message: `Scheduling IaC deployment`,
            imageDigest: image.imageDigest
          })
        }
      ).promise();

      console.info("doIaC", prettyPrint(callResult));

    } else {
      body.warnings.push(item.dockerRepo + " Already deploying");
    }
  }
}

async function doImage(body, item, image) {

  const data = await lambda.listTags({
    Resource: global.invokedFunctionArn
  }).promise();

  let currentImageDigest = data.Tags[tagPrefix + item.dockerRepo];
  if (image.imageDigest != currentImageDigest) {
    let mode = item.mode;

    if (mode == "ASG") {
      await doScanASG(body, item, image);
    }
    else {
      await doIaC(body, item, image);
    }
  }
}

async function doScanASG(body, item, image) {
  let list = await autoscaling.describeAutoScalingGroups().promise().then(e => e.AutoScalingGroups);

  for (const asg of list) {
    let deployPackages = asg.Tags.find(t => t.Key == "deploy.packages");

    if (deployPackages) {
      let asgDepartment = asg.Tags.find(t => t.Key == "Department");
      const packageList = deployPackages.Value.split(",");
      for (const p of packageList) {
        if (item.dockerRepo == asgDepartment.Value.toLowerCase() + "-" + p.trim()) {
          doDeployASG(asg, item, image);
        }
      }
    }
  }

  let params = {};
  params.Resource = global.invokedFunctionArn;
  params.Tags = {};
  let tagKey = tagPrefix + item.dockerRepo;
  params.Tags[tagKey] = image.imageDigest;

  await lambda.tagResource(params).promise();
  body.deployed.push(params.Tags);
}

async function doDeployASG(asg, item, image) {

  let message = "Instance Refresh: " + asg.AutoScalingGroupName;
  console.info(message);
  await autoscaling.startInstanceRefresh({
    AutoScalingGroupName: asg.AutoScalingGroupName
  }).promise();

  let callResult=await lambda.invoke(
    {
      FunctionName: `${department.toLowerCase()}-deploy-notify`,
      Payload: JSON.stringify({
        gitRepo: item.dockerRepo,
        area: area,
        status: 'Started',
        message: message,
        imageDigest: image.imageDigest
      })
    }
  ).promise();

  console.info("doDeployASG", prettyPrint(callResult));
}

async function listImages(warnings, repositoryName) {

  const params = {
    filter: {
      tagStatus: "TAGGED"
    }
  };

  params.repositoryName = area.toLowerCase() + "/" + repositoryName;

  try {
    const list = await ecr.listImages(params).promise();

    return list.imageIds.filter((element) => {
      return element.imageTag === "latest";
    });
  } catch (e) {
    let issue = {};
    issue.msg = "Could not find " + repositoryName;
    issue.error = e;
    warnings.push(issue);

    return [];
  }
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
