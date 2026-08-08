export interface AppVariables {
  requestId: string;
  installationId: string;
  adminUserId: string;
  adminPermissions: string[];
}

export type AppBindings = { Variables: AppVariables };
