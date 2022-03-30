terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 3.39"
    }
  }

  required_version = ">= 0.14.9"
}

# variable "monitor" {
#   type        = list(any)
#   description = "The repository list to monitor"
# }

variable "dockerAccountID" {
  type        = string
  description = "The AWS account to monitor"
}

/**
 * Standard variables
 */
data "aws_caller_identity" "current" {}

variable "area" {
  type        = string
  description = "The Area"
}

variable "department" {
  type        = string
  description = "The Department"
}

variable "region" {
  type        = string
  description = "The AWS region"
}

variable "package" {
  type        = string
  description = "The Package"
  default     = "Unknown"
}

variable "who" {
  type        = string
  description = "Who did deployment"
  default     = "Unknown"
}

variable "digest" {
  type        = string
  description = "The docker image Digest"
  default     = "Unknown"
}

variable "gitOrganization" {
  type        = string
  description = "GitHub Organization"
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Package    = var.package
      Area       = var.area
      Department = var.department
      Who        = var.who
      Digest     = var.digest
    }
  }

  ignore_tags {
    key_prefixes = ["deploy.state/"]
  }
}

data "aws_default_tags" "current" {}

data "aws_ami" "amazon-linux-2" {
  most_recent = true

  owners = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm*"]
  }
}

data "aws_vpc" "main" {

  filter {
    name   = "tag:Name"
    values = ["Main"]
  }
}

data "aws_subnet_ids" "private" {
  vpc_id = data.aws_vpc.main.id

  filter {
    name   = "tag:Type"
    values = ["PRIVATE"]
  }
}

data "aws_security_group" "default" {
  name   = "default"
  vpc_id = data.aws_vpc.main.id
}

/**
 * Redeploy on change
 */
resource "aws_iam_role" "deploy" {
  name               = join("_", [local.function_name, "v2"])
  assume_role_policy = file("policies/assume_role_lambda.json")
  inline_policy {
    name = "POLICY"
    policy = replace(
      replace(
        replace(
          replace(
            file("policies/deploy.json"),
            "$${ACCOUNT_ID}",
            data.aws_caller_identity.current.account_id
          ),
          "$${REGION}",
          lower(var.region)
        ),
        "$${DEPARTMENT}",
        lower(var.department)
      ),
      "$${AREA}",
      lower(var.area)
    )
  }
}

/**
 * notify policy
 */
resource "aws_iam_role" "deploy_notify" {
  name               = local.deploy_notify_name
  assume_role_policy = file("policies/assume_role_lambda.json")
  inline_policy {
    name = "POLICY"
    policy = replace(
      replace(
        replace(
          replace(
            file("policies/deploy_notify.json"),
            "$${ACCOUNT_ID}",
            data.aws_caller_identity.current.account_id
          ),
          "$${REGION}",
          lower(var.region)
        ),
        "$${DEPARTMENT}",
        lower(var.department)
      ),
      "$${AREA}",
      lower(var.area)
    )
  }
}

resource "aws_lambda_alias" "deploy_alias" {
  name             = "deploy_alias"
  description      = "Latest deploy function"
  function_name    = aws_lambda_function.deploy.function_name
  function_version = "$LATEST"
}

resource "aws_lambda_permission" "allow_cloudwatch" {
  statement_id   = join("-", [var.department, "allowExecutionFromCloudWatch"])
  action         = "lambda:InvokeFunction"
  function_name  = local.function_name
  principal      = "events.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
  source_arn     = aws_cloudwatch_event_rule.deploy.arn
}

data "archive_file" "deploy" {
  type        = "zip"
  source_file = "${path.module}/lambda/deploy.js"
  output_path = "${path.module}/.tmp/deploy.zip"
}

data "archive_file" "deploy_notify" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/deploy_notify"
  output_path = "${path.module}/.tmp/deploy_notify.zip"
}

locals {
  function_name      = join("-", [lower(var.department), "deploy"])
  deploy_notify_name = join("-", [lower(var.department), "deploy", "notify"])
}

resource "aws_iam_role_policy_attachment" "AWSLambdaVPCAccessExecutionRole" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_lambda_function" "deploy" {
  function_name = local.function_name
  role          = aws_iam_role.deploy.arn
  runtime       = "nodejs14.x"
  handler       = "deploy.handler"
  filename      = data.archive_file.deploy.output_path
  timeout       = 59
  memory_size   = 192

  vpc_config {
    subnet_ids         = data.aws_subnet_ids.private.ids
    security_group_ids = [data.aws_security_group.default.id]
  }

  source_code_hash = filebase64sha256(data.archive_file.deploy.output_path)

  depends_on = [

    aws_cloudwatch_log_group.deploy,
  ]

  environment {
    variables = {
      AREA       = var.area,
      DEPARTMENT = var.department,
      repoName   = join("-", [lower(var.department), lower(var.package)]),

      deployASG = aws_autoscaling_group.deploy_iac.name
    }
  }

}

resource "aws_lambda_function" "deploy_notify" {
  function_name = local.deploy_notify_name
  role          = aws_iam_role.deploy_notify.arn
  runtime       = "nodejs14.x"
  handler       = "deploy_notify.handler"
  filename      = data.archive_file.deploy_notify.output_path
  timeout       = 59
  memory_size   = 192

  vpc_config {
    subnet_ids         = data.aws_subnet_ids.private.ids
    security_group_ids = [data.aws_security_group.default.id]
  }

  source_code_hash = filebase64sha256(data.archive_file.deploy_notify.output_path)

  environment {
    variables = {
      gitOrganization = var.gitOrganization
    }
  }

  depends_on = [

    aws_cloudwatch_log_group.deploy_notify,
  ]
}

resource "aws_cloudwatch_log_group" "deploy" {
  name              = join("", ["/aws/lambda/", local.function_name])
  retention_in_days = 90
}

resource "aws_cloudwatch_log_group" "deploy_notify" {
  name              = join("", ["/aws/lambda/", local.deploy_notify_name])
  retention_in_days = 90
}

resource "aws_cloudwatch_event_rule" "deploy" {
  name                = local.function_name
  description         = "Check if any managed docker images have changed, if changed deploy"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "invoke_deploy" {
  target_id = "scheduled-task-every-minute"
  rule      = aws_cloudwatch_event_rule.deploy.id
  arn       = aws_lambda_function.deploy.arn
}

#
# Deploy IaC docker image
#
resource "aws_iam_role" "deploy_iac" {
  name               = join("-", [lower(var.department), "deploy", "iac"])
  assume_role_policy = file("policies/assume_role_ec2.json")

  managed_policy_arns = [
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    "arn:aws:iam::aws:policy/AdministratorAccess"
  ]
}

resource "aws_iam_role_policy_attachment" "deploy_iac" {
  role       = aws_iam_role.deploy_iac.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "deploy_iac" {
  name = join("-", [lower(var.department), "deploy", "iac"])
  role = aws_iam_role.deploy_iac.name
}

locals {
  name           = join("-", [lower(var.department), "deploy", "iac"])
  base64_init_sh = base64gzip(file("${path.module}/user_data/init.sh"))
  base64_run_sh  = base64gzip(file("${path.module}/user_data/run.sh"))
  base64_pull_sh = base64gzip(file("${path.module}/user_data/pull.sh"))
  base64_awscli_conf = base64gzip(
    replace(
      file("awslogs/awscli.conf"),
      "$${REGION}",
      lower(var.region)
    )
  )
  base64_awslogs_conf = base64gzip(
    replace(
      file("awslogs/awslogs.conf"),
      "$${NAME}",
      local.name
    )
  )
}

resource "aws_launch_template" "deploy_iac" {
  description = "Deploy the IaC docker image"
  name        = join("-", [lower(var.department), "deploy", "iac"])

  image_id = data.aws_ami.amazon-linux-2.id

  # instance_initiated_shutdown_behavior = "terminate"

  iam_instance_profile {
    name = aws_iam_instance_profile.deploy_iac.name
  }

  instance_type = "t3.micro"

  monitoring {
    enabled = true
  }

  update_default_version = true

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name        = "Deploy IaC"
      Environment = var.area
    }
  }

  user_data = base64encode(
    replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    file(
                      "user_data/boot-script.sh"
                    ),
                    "$${BASE64_INIT_SH}",
                    local.base64_init_sh
                  ),
                  "$${BASE64_PULL_SH}",
                  local.base64_pull_sh
                ),
                "$${BASE64_RUN_SH}",
                local.base64_run_sh
              ),
              "$${AREA}",
              var.area
            ),
            "$${DEPARTMENT}",
            var.department
          ),
          "$${ACCOUNT_ID}",
          data.aws_caller_identity.current.account_id
        ),
        "$${BASE64_AWSCLI_CONF}",
        local.base64_awscli_conf
      ),
      "$${BASE64_AWSLOGS_CONF}",
      local.base64_awslogs_conf
    )
  )
}

resource "aws_cloudwatch_log_group" "messages" {
  name              = join("/", [local.name, "messages"])
  retention_in_days = 90
}

resource "aws_cloudwatch_log_group" "output" {
  name              = join("/", [local.name, "output"])
  retention_in_days = 90
}

resource "aws_autoscaling_group" "deploy_iac" {

  desired_capacity    = 0
  max_size            = 1
  min_size            = 0
  vpc_zone_identifier = data.aws_subnet_ids.private.ids

  mixed_instances_policy {
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.deploy_iac.id
        version            = "$Default"
      }
    }
  }
  health_check_type = "EC2"

  dynamic "tag" {
    for_each = data.aws_default_tags.current.tags
    content {
      key                 = tag.key
      value               = tag.value
      propagate_at_launch = true
    }
  }

  lifecycle {
    ignore_changes = [
      desired_capacity
    ]
  }
}

resource "aws_autoscaling_schedule" "deploy_iac_remove-dead" {
  scheduled_action_name  = "RemoveDeadInstances"
  min_size               = 0
  max_size               = 1
  desired_capacity       = 0
  recurrence             = "30 8 * * *"
  autoscaling_group_name = aws_autoscaling_group.deploy_iac.name
}

locals {
  ecr_policies = var.dockerAccountID == data.aws_caller_identity.current.account_id ? [] : ["one"]
}

resource "aws_ecr_registry_policy" "allow_push" {
  count = length(local.ecr_policies)
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid    = "AllowPush",
        Effect = "Allow",
        Principal = {
          "AWS" : "arn:aws:iam::${var.dockerAccountID}:root"
        },
        Action = [
          "ecr:CreateRepository",
          "ecr:ReplicateImage"
        ],
        Resource = [
          join(":", [
            "arn:aws:ecr",
            lower(var.region),
            data.aws_caller_identity.current.account_id,
            join("/", ["repository", lower(var.area), "${lower(var.department)}-*"])
            ]
          )
        ]
      }
    ]
  })
}

resource "aws_sns_topic" "deploy_start" {
  name = join("-", [lower(var.department), "deploy", "start"])
}

resource "aws_sns_topic" "deploy_finished" {
  name = join("-", [lower(var.department), "deploy", "finished"])
}

resource "aws_sns_topic" "deploy_error" {
  name = join("-", [lower(var.department), "deploy", "error"])
}
