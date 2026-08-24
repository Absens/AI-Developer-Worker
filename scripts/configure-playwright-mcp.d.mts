export const PLAYWRIGHT_MCP_MANAGED_BEGIN: string;
export const PLAYWRIGHT_MCP_MANAGED_END: string;

export interface ConfigurePlaywrightMcpConfigInput {
  codexHome: string;
  enabled: boolean;
  url: string;
}

export interface ConfigurePlaywrightMcpConfigResult {
  configPath: string;
  changed: boolean;
  enabled: boolean;
}

export function configurePlaywrightMcpConfig(
  input: ConfigurePlaywrightMcpConfigInput,
): Promise<void>;
