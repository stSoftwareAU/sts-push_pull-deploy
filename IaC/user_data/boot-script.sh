#!/bin/bash
set -ex

function findIdentity(){
  tmpIdentity=$(mktemp /tmp/identity_XXXXXX.json)
  curl -s http://169.254.169.254/latest/dynamic/instance-identity/document > ${tmpIdentity}

  jq . ${tmpIdentity}

  INSTANCE_ID=$( jq -r '.instanceId' ${tmpIdentity})

  ACCOUNT_ID=$(jq -r .AccountId  ${tmpIdentity})
  REGION=$( jq -r '.region' ${tmpIdentity})

  rm ${tmpIdentity}
}

function handleError() {
  echo "ERROR: $1 occured on $2"
  doShutdown 2
}

function doShutdown() {
  set +e

  if [[ -z "$1" ]]; then
    exitCode=3
  else
    exitCode=$1
  fi
  # Make sure the output has been written.
  sync
  sleep 2
  FILE="/var/log/cloud-init-output.log"
  if [[ ${exitCode} != 0 ]]; then
    # MSG="Failed to deploy ${DOCKER_REPO} to ${AREA}"
    STATUS="failed"
    checkFile="/var/log/apply.err"
    if [[ -s "${checkFile}" ]]; then
      FILE="${checkFile}"
    fi
  else
    # MSG="Deployed ${DOCKER_REPO} into ${AREA}"
    STATUS="OK"
    checkFile="/var/log/apply.log"
    if [[ -s "${checkFile}" ]]; then
      FILE="${checkFile}"
    fi
  fi
  #echo "${MSG} file://${FILE}"
  cat "${FILE}"
  
  MSG_B64=$(cat ${FILE}|base64 --wrap=0)
  tmpPayload=$(mktemp /tmp/payload_XXXXXX.json)
  imageDigest=$(docker images --digests |grep "${DOCKER_REPO}" |grep -v "<none>"|grep latest|sed -e's/  */ /g' | cut -f 3 -d ' ')

  jq ".gitRepo=\"${DOCKER_REPO}\" | .area=\"${AREA}\" | .status=\"${STATUS}\" | .messageB64=\"${MSG_B64}\" | .imageDigest=\"${imageDigest}\"" <<<"{}" > ${tmpPayload}

  # jq . ${tmpPayload}
  PAYLOAD=$(cat ${tmpPayload})

  aws --region "${REGION}" lambda invoke \
      --function-name ${DEPARTMENT,,}-deploy-notify \
      --payload "${PAYLOAD}" \
      invoke.json

  STATUS=$(jq -r .statusCode invoke.json )

  if [[ ${STATUS} != 200 ]]; then 
    echo "FAILED: ${STATUS}"
    jq . invoke.json
  fi

  tmpInstance=$(mktemp /tmp/instance_XXXXXX.json)
  aws ec2 describe-instances --instance-ids ${INSTANCE_ID} --region ${REGION} > ${tmpInstance}
  
  jq . ${tmpInstance}
  AUTO_SCALE_GROUP=$( jq -r '.Reservations[0].Instances[0].Tags[]| select(.Key == "aws:autoscaling:groupName") .Value' ${tmpInstance})

  if [[ -z ${AUTO_SCALE_GROUP} ]]; then
    MSG="ERROR: no autoscale groupd for: ${INSTANCE_ID}"
    echo ${MSG}
    shutdown +1 "${MSG}"
    exit 4
  else
    MSG="Change capacity of ${AUTO_SCALE_GROUP} to ZERO"

    aws autoscaling update-auto-scaling-group \
     --auto-scaling-group-name ${AUTO_SCALE_GROUP} \
     --region ${REGION} \
     --desired-capacity 0 \
     --min-size 0

     shutdown +1 "${MSG}"
     exit ${exitCode}
  fi
}

function setupNobody() {

  amazon-linux-extras install docker
  usermod -a -G docker nobody
  service docker start

  mkdir -p /home/nobody
  usermod -d /home/nobody nobody
  usermod --shell /bin/bash nobody
}

function setupEnv() {
  export DEPARTMENT="${DEPARTMENT}"
  export AREA="${AREA}"
  export REGION="${REGION}"

  tmpTags=$(mktemp /tmp/tags_XXXXXX.json)
  aws ec2 describe-tags --region ${REGION} --filter "Name=resource-id,Values=${INSTANCE_ID}" > ${tmpTags}
  # jq . ${tmpTags}

  export DOCKER_REPO=$(jq --raw-output '.Tags[] | select(.Key=="deploy.state/DOCKER_REPO") .Value' ${tmpTags})

  if [[ -z "${DOCKER_REPO}" ]]; then
    echo "ERROR: no DOCKER_REPO tag"
    doShutdown 5
  fi

  rm ${tmpTags}
  ENV_FILE=/home/nobody/.env
  echo "# Auto generated" > ${ENV_FILE}
  echo "REGION=${REGION}" >> ${ENV_FILE}
  echo "GIT_REPO=${DOCKER_REPO}" >> ${ENV_FILE}
  echo "AREA=${AREA}" >> ${ENV_FILE}
  echo "ACCOUNT_ID=${ACCOUNT_ID}" >> ${ENV_FILE}
  echo "DEPARTMENT=${DEPARTMENT}" >> ${ENV_FILE}
}

function setupScripts() {
  echo "${BASE64_INIT_SH}" | base64 -d | gzip --decompress --stdout > /home/nobody/init.sh
  echo "${BASE64_PULL_SH}" | base64 -d | gzip --decompress --stdout > /home/nobody/pull.sh
  echo "${BASE64_RUN_SH}" | base64 -d | gzip --decompress --stdout > /home/nobody/run.sh

  chown -R nobody:nobody /home/nobody
  chmod u+x /home/nobody/*.sh
}

trap 'handleError $? $LINENO' ERR
yum install jq awslogs -y

echo "${BASE64_AWSCLI_CONF}" | base64 -d | gzip --decompress --stdout > /etc/awslogs/awscli.conf
echo "${BASE64_AWSLOGS_CONF}" | base64 -d | gzip --decompress --stdout > /etc/awslogs/awslogs.conf

service awslogsd restart

findIdentity
setupNobody
setupEnv
setupScripts

sudo -u nobody /home/nobody/pull.sh
sudo -u nobody /home/nobody/run.sh --require 3.4 --mode apply-no-color > /var/log/apply.log 2> /var/log/apply.err
cat /var/log/apply.log

doShutdown 0
