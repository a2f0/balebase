# State lives in Cloudflare R2 (S3-compatible). terraform/scripts/run.sh maps
# the tier's TF_STATE_* credentials to the AWS variables the backend reads.
terraform {
  backend "s3" {
    bucket = "balebase-terraform-state"
    key    = "staging/terraform.tfstate"
    region = "auto"
    endpoints = {
      s3 = "https://0be508e6c4caa573595c5f94e11900e4.r2.cloudflarestorage.com"
    }
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
