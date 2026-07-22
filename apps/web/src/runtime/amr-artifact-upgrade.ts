export const AMR_ARTIFACT_UPGRADE_REQUEST_EVENT =
  'open-design:amr-artifact-upgrade-request';

const ARTIFACT_UPGRADE_OPTOUT_KEY = 'open-design:amr-artifact-upgrade-optout:v1';

/** Whether the user permanently opted out of the artifact upgrade surfaces
 * ("don't show this again"). Covers both the send-pausing dialog and the
 * home offer card, across every project/conversation and app restarts.
 * Same client-preference pattern as the low-balance warn opt-out. */
export function isAmrArtifactUpgradeOptedOut(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ARTIFACT_UPGRADE_OPTOUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAmrArtifactUpgradeOptedOut(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ARTIFACT_UPGRADE_OPTOUT_KEY, '1');
  } catch {
    // Persistence failure just means the upsell can show again next time.
  }
}

/** Which kind of runtime the active conversation executes on, for upsell
 * scoping. 'cloud' = the Open Design Cloud (AMR) daemon agent; 'cli' = any
 * other local daemon agent, i.e. the user demonstrably runs their own CLI
 * subscription; 'api' = BYOK API mode, whose keys can point at Open Design
 * Cloud at any time and therefore follows the same rules as 'cloud'. */
export type AmrUpsellRuntimeClass = 'cloud' | 'cli' | 'api';

const ARTIFACT_UPGRADE_CLI_INTRO_SHOWN_KEY =
  'open-design:amr-artifact-upgrade-cli-intro-shown:v1';

/** Whether a user working on a local CLI runtime already got their one-time
 * introduction to the upgrade offer. The first eligible surface (send-pause
 * dialog or home card, whichever comes first) shows with full original
 * semantics and sets this flag; both surfaces then stay retired for 'cli'
 * contexts. 'cloud' and 'api' contexts never consult it. */
export function isAmrArtifactUpgradeCliIntroShown(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ARTIFACT_UPGRADE_CLI_INTRO_SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setAmrArtifactUpgradeCliIntroShown(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ARTIFACT_UPGRADE_CLI_INTRO_SHOWN_KEY, '1');
  } catch {
    // Persistence failure just means the intro may show once more.
  }
}

export type AmrArtifactUpgradeDecision = 'proceed' | 'cancel';

export interface AmrArtifactUpgradeHomeOffer {
  sessionKey: string;
  projectId: string;
  conversationId: string;
  fileName: string | null;
}

export interface AmrArtifactUpgradeRequest {
  projectId: string;
  conversationId: string;
  source: 'chat_send';
}

export interface AmrArtifactUpgradeRequestDetail {
  projectId: string;
  conversationId: string;
  source: 'chat_send';
  settle: (decision: AmrArtifactUpgradeDecision) => void;
}

export function amrArtifactUpgradeHomeMockOffer(
  search: string,
): AmrArtifactUpgradeHomeOffer | null {
  const params = new URLSearchParams(search);
  if (params.get('mock-amr-artifact-upgrade-home') !== '1') return null;

  const projectId = params.get('mock-amr-artifact-upgrade-project')?.trim() ?? '';
  const conversationId =
    params.get('mock-amr-artifact-upgrade-conversation')?.trim() ?? '';
  const sessionKey = amrArtifactUpgradeSessionKey(projectId, conversationId);
  if (!sessionKey) {
    return {
      sessionKey: 'local-ui-mock',
      projectId: '',
      conversationId: '',
      fileName: null,
    };
  }

  return {
    sessionKey,
    projectId,
    conversationId,
    fileName: params.get('mock-amr-artifact-upgrade-file')?.trim() || null,
  };
}

export function amrArtifactUpgradeSessionKey(
  projectId: string | null | undefined,
  conversationId: string | null | undefined,
): string | null {
  const normalizedProjectId = projectId?.trim();
  const normalizedConversationId = conversationId?.trim();
  if (!normalizedProjectId || !normalizedConversationId) return null;
  return JSON.stringify([normalizedProjectId, normalizedConversationId]);
}

export function requestAmrArtifactUpgrade(
  request: AmrArtifactUpgradeRequest,
): Promise<AmrArtifactUpgradeDecision> {
  if (
    typeof window === 'undefined'
    || !amrArtifactUpgradeSessionKey(request.projectId, request.conversationId)
    || request.source !== 'chat_send'
  ) {
    return Promise.resolve('proceed');
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (decision: AmrArtifactUpgradeDecision) => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };
    const accepted = window.dispatchEvent(new CustomEvent<AmrArtifactUpgradeRequestDetail>(
      AMR_ARTIFACT_UPGRADE_REQUEST_EVENT,
      {
        cancelable: true,
        detail: { ...request, settle },
      },
    ));
    if (accepted) settle('proceed');
  });
}
