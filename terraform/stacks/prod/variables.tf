variable "cloudflare_api_token" {
  description = "Cloudflare API token loaded from .secrets/prod."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID loaded from .secrets/prod."
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
  default     = "balebase-db"
}

variable "r2_bucket_name" {
  description = "Name of the R2 bucket bound to the API Worker."
  type        = string
  default     = "balebase-objects"
}

variable "inbound_email_subdomain" {
  description = "Subdomain that receives organization uploads through Email Routing."
  type        = string
  default     = "inbox.balebase.com"
}

variable "inbound_email_address" {
  description = "Base email address routed to the API Worker's email handler."
  type        = string
  default     = "upload@inbox.balebase.com"
}

variable "enable_custom_domains" {
  description = "Attach the canonical hostnames after the target Workers are deployed."
  type        = bool
  default     = true
}

variable "website_hostname" {
  description = "Hostname for the Astro marketing website Worker."
  type        = string
  default     = "balebase.com"
}

variable "client_hostname" {
  description = "Hostname for the React client Worker."
  type        = string
  default     = "app.balebase.com"
}

variable "api_hostname" {
  description = "Hostname for the API Worker."
  type        = string
  default     = "api.balebase.com"
}

variable "website_worker_name" {
  description = "Deployed name of the website Worker."
  type        = string
  default     = "balebase-website"
}

variable "client_worker_name" {
  description = "Deployed name of the client Worker."
  type        = string
  default     = "balebase-client"
}

variable "api_worker_name" {
  description = "Deployed name of the API Worker."
  type        = string
  default     = "balebase-api"
}
