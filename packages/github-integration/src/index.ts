export { parseGhStatusScopes } from "./gh-cli.ts";
export { DEVICE_SCOPES, DeviceFlowManager, type DeviceFlowDeps } from "./device-flow.ts";
export { GithubError, type GithubErrorCode } from "./errors.ts";
export { CLIENT_ID_SETTING, createGithubService, type GithubService, type GithubServiceDeps } from "./service.ts";
export type { CreatePullInput } from "./pull-requests.ts";
