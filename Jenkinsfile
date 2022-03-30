/*
 * WARNING: Automatically copied from sts-tools
 */
TOOLS_IMAGE = 'sts-tools:latest'
TOOLS_ARGS = '--volume /var/run/docker.sock:/var/run/docker.sock --volume /tmp:/tmp'

/*
 * UTC About Midday Sydney time on a Tuesday->Thursday for Prod/Identity,
 * any work hour for Dev/Staging/Pipeline.
 */
CRON_TAB = BRANCH_NAME ==~ /(Production|Identity)/ ? "H H(2-3) * * H(2-4)" : BRANCH_NAME ==~ /(Develop|Staging|Pipeline)/ ? "H H(0-5) * * H(1-5)": ""

pipeline {
  agent none

  triggers {
    pollSCM( '* * * * *')
    cron( CRON_TAB) 
  }

  options {
    timeout(time: 1, unit: 'HOURS')
    disableConcurrentBuilds()
    parallelsAlwaysFailFast()
  }

  stages {
    stage('Reformat') {
      when {
        not {
          anyOf {
            branch 'Production';
            branch 'Staging';
            branch 'Identity';
            branch 'Pipeline';
            branch 'Develop'
          }
        }
        beforeAgent true
      }

      agent {
        docker {
          image TOOLS_IMAGE
          args TOOLS_ARGS
        }
      }

      steps {
        withCredentials([sshUserPrivateKey(credentialsId: "GitHub-ssh", keyFileVariable: 'keyfile')]) {

          sh '''
            mkdir -p ~/.ssh
            ssh-keyscan -t rsa github.com >> ~/.ssh/known_hosts
            echo "Host github.com" > ~/.ssh/config
            echo " HostName github.com" >> ~/.ssh/config
            echo " IdentityFile ${keyfile}" >> ~/.ssh/config

            git config --global user.email "pipeline@data.gov.au"
            git config --global user.name "Jenkins"
        
            cd ${WORKSPACE}
            
            rm -rf scratch
            git clone ${GIT_URL//https:\\/\\/github.com\\//git@github.com:} scratch
            cd scratch
            git checkout ${BRANCH_NAME}
            cat > /tmp/json.sh << EOF
            FILE=\\$1
            echo "reformat \\${FILE}"
            tmpJSON=\\$(mktemp -t reformat_XXXXXXXXXX.json)
            jq . \\${FILE} > \\${tmpJSON}
            mv --force \\${tmpJSON} \\${FILE}
            EOF
            
            find . -name "*.json" -exec bash /tmp/json.sh {} \\;

            docker run --volume $(pwd)/IaC:/home/IaC --rm hashicorp/terraform:light -chdir=/home/IaC fmt
            git add .
            set +e

            git commit -m "Reformat of code"
            git push
          '''.stripIndent()
        }
      }
    }
    stage('Build') {

      when {        
        environment name: 'CHANGE_ID', value: '' // Not a Pull Request
        beforeAgent true
      }

      agent {
        docker {
          image TOOLS_IMAGE
          args TOOLS_ARGS
        }
      }

      steps {
        sh '''\
          #!/bin/bash
          set -ex

          /home/tools/build.sh
          /home/tools/push.sh
        '''.stripIndent()
      }
    }

    stage('QA') {
      parallel {
        stage('validate') {
          when {
            environment name: 'CHANGE_ID', value: '' // Not a Pull Request
            beforeAgent true
          }

          agent {
            docker {
              image TOOLS_IMAGE
              args TOOLS_ARGS
            }
          }
          steps {
            sh '''\
              #!/bin/bash
              set -ex

              /home/tools/pull.sh
              /home/tools/run.sh --require 3.8 --mode validate
              /home/tools/secrets_scan.sh
            '''.stripIndent()
          }
        }

        stage('CVE scan') {
          when {
            allOf {
              not { anyOf { branch 'Staging'; branch 'Production'; branch 'Identity'; branch 'Pipeline' } }
              environment name: 'CHANGE_ID', value: '' // Not a Pull Request
            }
            beforeAgent true
          }
          
          agent {
            docker {
              image TOOLS_IMAGE
              args TOOLS_ARGS
            }
          }

          steps {
            script {
              sh '''\
                #!/bin/bash
                set -ex

                /home/tools/cve-scan.sh
              '''.stripIndent()
            }
          }
          post {
            always {
              archiveArtifacts artifacts: 'cve-scan.json', fingerprint: true
            }
          }
        }
      }
    }

    stage('Release') {
      when {
        allOf {
          environment name: 'CHANGE_ID', value: ''
          anyOf {
            branch 'Production';
            branch 'Staging';
            branch 'Identity';
            branch 'Pipeline';
            branch 'Develop'
          }
        }
        beforeAgent true
      }
      
      agent {
        docker {
          image TOOLS_IMAGE
          args TOOLS_ARGS
        }
      }

      steps {
        sh '''\
          #!/bin/bash
          set -ex

          /home/tools/release.sh
        '''.stripIndent()
      }
    }

    stage('CleanUp') {
      when {
        not {
          anyOf {
            branch 'Production';
            branch 'Staging';
            branch 'Identity';
            branch 'Pipeline';
            branch 'Develop'
          }
        }
        beforeAgent true
      }
      
      agent {
        docker {
          image TOOLS_IMAGE
          args TOOLS_ARGS
        }
      }

      steps {
        sh '''\
          #!/bin/bash
          set -ex

          /home/tools/clean-up.sh
        '''.stripIndent()
      }
    }
  }
}
