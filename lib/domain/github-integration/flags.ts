/** New integrations remain disabled until the approved pilot is completed. */
export function publicUserAuthEnabled(): boolean {
  return process.env.PUBLIC_USER_AUTH_ENABLED === "true";
}

export function githubStarEnabled(): boolean {
  return process.env.GITHUB_STAR_ENABLED === "true";
}

export function productFeedbackEnabled(): boolean {
  return process.env.PRODUCT_FEEDBACK_ENABLED === "true";
}

export function githubFeedbackDeliveryEnabled(): boolean {
  return process.env.GITHUB_FEEDBACK_DELIVERY_ENABLED === "true";
}
