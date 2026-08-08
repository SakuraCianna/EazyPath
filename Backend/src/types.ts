export interface AppVariables {
  requestId: string;
  installationId: string;
  adminUserId: string;
  adminSessionId: string;
  adminUsername: string;
  adminRoleCode: string;
  adminPermissions: string[];
  adminCsrfHash: string;
}

export type AppBindings = { Variables: AppVariables };
