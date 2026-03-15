/**
 * AriseBrowser public type definitions.
 */

export interface AriseBrowserConfig {
  /** Connection mode:
   * - 'standalone': Launch new Chromium (default)
   * - 'cdp': Connect to existing browser via CDP
   * - 'managed': Persistent browser profile
   */
  mode: "standalone" | "cdp" | "managed";

  /** CDP endpoint URL (required for 'cdp' mode) */
  cdpUrl?: string;

  /** Run headless (standalone/managed mode, default true) */
  headless?: boolean;

  /** Profile directory (managed mode) */
  profileDir?: string;

  /** Viewport size */
  viewport?: { width: number; height: number };

  /** Custom user agent */
  userAgent?: string;

  /** Apply safe stealth context options (default true) */
  stealthHeaders?: boolean;

  /** Virtual display mode (Linux server) */
  virtualDisplay?: {
    enabled: boolean;
    display?: string;
    screen?: string;
    nekoPort?: number;
    nekoPassword?: string;
    nekoAdminPassword?: string;
    chromeDebugPort?: number;
    chromePath?: string;
  };
}

export type ActionDict = Record<string, unknown>;

export interface ActionResult {
  success: boolean;
  message: string;
  details: Record<string, unknown>;
}

export interface TabInfo {
  tab_id: string;
  url: string;
  title: string;
  is_current: boolean;
}

export interface SessionRef {
  getTabInfo(): Promise<TabInfo[]>;
  switchToTab(tabId: string): Promise<boolean>;
}

export interface RecordedOperation {
  type: string;
  timestamp: string;
  url?: string;
  ref?: string;
  text?: string;
  role?: string;
  value?: string;
  tab_id?: string;
  direction?: string;
  amount?: number;
  request_url?: string;
  method?: string;
  status?: number;
  [key: string]: unknown;
}

export interface RecordingResult {
  session_id: string;
  operations: RecordedOperation[];
  operations_count: number;
  snapshots: Record<string, SnapshotRecord>;
}

export interface SnapshotRecord {
  url: string;
  snapshot_text?: string;
  simple?: Record<string, unknown>;
  captured_at: string;
}

export interface SnapshotResult {
  snapshotText: string;
  elements: Record<string, unknown>;
  metadata?: {
    refDebug?: {
      weakmapHit?: number;
      ariaRefHit?: number;
      signatureHit?: number;
      newRef?: number;
      evicted?: number;
    };
    refCounterValue?: number;
    totalMappedRefs?: number;
  };
}

export interface ServerConfig {
  port?: number;
  host?: string;
  token?: string;
}

export interface TabLock {
  owner: string;
  expiresAt: number;
}

export interface LearnData {
  type: "browser_workflow";
  task: string;
  success: boolean;
  source: string;
  domain: string;
  steps: LearnStep[];
  metadata: {
    duration_ms: number;
    page_count: number;
    recorded_at: string;
  };
}

export interface LearnStep {
  url: string;
  action: string;
  target?: string;
  value?: string;
}
