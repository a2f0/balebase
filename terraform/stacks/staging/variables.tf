variable "cloudflare_api_token" {
  description = "Cloudflare API token loaded from .secrets/staging."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID loaded from .secrets/staging."
  type        = string
}

variable "domain" {
  description = "Cloudflare zone used by the product."
  type        = string
  default     = "balebase.com"
}

variable "d1_database_name" {
  description = "Name of the D1 database bound to the API Worker."
  type        = string
  default     = "balebase-db-staging"
}

variable "r2_bucket_name" {
  description = "Name of the R2 bucket bound to the API Worker."
  type        = string
  default     = "balebase-objects-staging"
}

variable "inbound_email_subdomain" {
  description = "Subdomain that receives organization uploads through Email Routing."
  type        = string
  default     = "inbox-staging.balebase.com"
}

variable "inbound_email_address" {
  description = "Base email address routed to the API Worker's email handler."
  type        = string
  default     = "upload@inbox-staging.balebase.com"
}

variable "enable_custom_domains" {
  description = "Attach the canonical hostnames after the target Workers are deployed."
  type        = bool
  default     = true
}

variable "enable_email_routing" {
  description = "Add the staging inbound mail route after its Worker exists."
  type        = bool
  default     = true
}

variable "website_hostname" {
  description = "Hostname for the Astro marketing website Worker."
  type        = string
  default     = "website-staging.balebase.com"
}

variable "client_hostname" {
  description = "Hostname for the React client Worker."
  type        = string
  default     = "app-staging.balebase.com"
}

variable "api_hostname" {
  description = "Hostname for the API Worker."
  type        = string
  default     = "api-staging.balebase.com"
}

variable "website_worker_name" {
  description = "Deployed name of the website Worker."
  type        = string
  default     = "balebase-website-staging"
}

variable "client_worker_name" {
  description = "Deployed name of the client Worker."
  type        = string
  default     = "balebase-client-staging"
}

variable "api_worker_name" {
  description = "Deployed name of the API Worker."
  type        = string
  default     = "balebase-api-staging"
}
