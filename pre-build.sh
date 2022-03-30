#!/bin/bash
set -e
BASE_DIR="$( cd -P "$( dirname "$BASH_SOURCE" )" && pwd -P )"
cd "${BASE_DIR}"

cp /home/tools/init.sh IaC/user_data/
cp /home/tools/run.sh IaC/user_data/
cp /home/tools/pull.sh IaC/user_data/
