function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
  }
  return value;
}

export const env = {
  get SLACK_SIGNING_SECRET() {
    return required("SLACK_SIGNING_SECRET");
  },
  get SLACK_BOT_TOKEN() {
    return required("SLACK_BOT_TOKEN");
  },
  get SLACK_USER_TOKEN() {
    return required("SLACK_USER_TOKEN");
  },
  get OWNER_SLACK_USER_ID() {
    return required("OWNER_SLACK_USER_ID");
  },
};
