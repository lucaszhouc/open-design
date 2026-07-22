import { useEffect, useRef, useState } from 'react';
import {
  DAEMON_RUN_FINISHED_EVENT,
  type DaemonRunFinishedEventDetail,
} from '../providers/daemon';
import {
  AMR_ARTIFACT_UPGRADE_REQUEST_EVENT,
  amrArtifactUpgradeSessionKey,
  isAmrArtifactUpgradeCliIntroShown,
  isAmrArtifactUpgradeOptedOut,
  setAmrArtifactUpgradeCliIntroShown,
  type AmrArtifactUpgradeDecision,
  type AmrArtifactUpgradeHomeOffer,
  type AmrArtifactUpgradeRequestDetail,
  type AmrUpsellRuntimeClass,
} from '../runtime/amr-artifact-upgrade';
import { isFreeAmrPlan } from '../runtime/amr-low-balance-plan';
import { AmrArtifactUpgradeDialog } from './AmrArtifactUpgradeDialog';

interface Props {
  plan: string | null;
  planResolved: boolean;
  /** How the active conversation executes. 'cloud' (the AMR agent) and 'api'
   * (BYOK keys, swappable to Open Design Cloud at any time) get the original
   * per-session upsell semantics. 'cli' (any other local daemon agent — the
   * user demonstrably runs their own subscription) gets exactly one full
   * introduction ever: the first surface that would fire shows normally,
   * then a persisted flag retires both surfaces for 'cli' contexts. */
  runtimeClass: AmrUpsellRuntimeClass;
  profile: string | null;
  metricsConsent: boolean;
  installationId: string | null | undefined;
  homeVisible: boolean;
  activeProjectId: string | null;
  activeConversationId: string | null;
  activeFileName: string | null;
  onHomeOfferChange?: (offer: AmrArtifactUpgradeHomeOffer | null) => void;
}

interface RouteSurface {
  homeVisible: boolean;
  offer: AmrArtifactUpgradeHomeOffer | null;
}

interface PendingSendDecision {
  sessionKey: string;
  settle: (decision: AmrArtifactUpgradeDecision) => void;
}

function hasOpenModal(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector(
    '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
  ) !== null;
}

function homeOfferForRoute(
  projectId: string | null,
  conversationId: string | null,
  fileName: string | null,
): AmrArtifactUpgradeHomeOffer | null {
  const normalizedProjectId = projectId?.trim();
  const normalizedConversationId = conversationId?.trim();
  const sessionKey = amrArtifactUpgradeSessionKey(
    normalizedProjectId,
    normalizedConversationId,
  );
  if (!sessionKey || !normalizedProjectId || !normalizedConversationId) return null;
  return {
    sessionKey,
    projectId: normalizedProjectId,
    conversationId: normalizedConversationId,
    fileName: fileName || null,
  };
}

export function AmrArtifactUpgradeGate({
  plan,
  planResolved,
  runtimeClass,
  profile,
  metricsConsent,
  installationId,
  homeVisible,
  activeProjectId,
  activeConversationId,
  activeFileName,
  onHomeOfferChange,
}: Props) {
  const [pendingRevision, setPendingRevision] = useState(0);
  const [dialogSessionKey, setDialogSessionKey] = useState<string | null>(null);
  const [pendingHomeOffer, setPendingHomeOffer] =
    useState<AmrArtifactUpgradeHomeOffer | null>(null);
  const openRef = useRef(false);
  const pendingSendRef = useRef<PendingSendDecision | null>(null);
  const eligibleSessionsRef = useRef<Set<string>>(new Set());
  const promptedSessionsRef = useRef<Set<string>>(new Set());
  const homeOfferedSessionsRef = useRef<Set<string>>(new Set());
  const seenRunIdsRef = useRef<Set<string>>(new Set());
  const previousSurfaceRef = useRef<RouteSurface>({
    homeVisible,
    offer: homeOfferForRoute(
      activeProjectId,
      activeConversationId,
      activeFileName,
    ),
  });

  useEffect(() => {
    const handleRunFinished = (event: Event) => {
      const detail = (event as CustomEvent<DaemonRunFinishedEventDetail>).detail;
      const sessionKey = detail
        ? amrArtifactUpgradeSessionKey(detail.projectId, detail.conversationId)
        : null;
      if (
        !detail
        || typeof detail.runId !== 'string'
        || !detail.runId.trim()
        || !sessionKey
        || detail.result !== 'success'
        || !Number.isFinite(detail.artifactCount)
        || detail.artifactCount <= 0
        || seenRunIdsRef.current.has(detail.runId)
      ) {
        return;
      }
      seenRunIdsRef.current.add(detail.runId);
      eligibleSessionsRef.current.add(sessionKey);
    };
    window.addEventListener(DAEMON_RUN_FINISHED_EVENT, handleRunFinished);
    return () => window.removeEventListener(DAEMON_RUN_FINISHED_EVENT, handleRunFinished);
  }, []);

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const requestEvent = event as CustomEvent<AmrArtifactUpgradeRequestDetail>;
      const detail = requestEvent.detail;
      const sessionKey = detail
        ? amrArtifactUpgradeSessionKey(detail.projectId, detail.conversationId)
        : null;
      // Opted-out users and CLI-runtime users who already had their one-time
      // introduction pass through untouched: no preventDefault, no pause —
      // the dispatch settles as 'proceed'. 'cloud' and 'api' contexts keep
      // the original per-session interception.
      if (
        !sessionKey
        || detail.source !== 'chat_send'
        || !eligibleSessionsRef.current.has(sessionKey)
        || !planResolved
        || !isFreeAmrPlan(plan)
        || (runtimeClass === 'cli' && isAmrArtifactUpgradeCliIntroShown())
        || isAmrArtifactUpgradeOptedOut()
      ) {
        return;
      }

      // A modal makes a second click impossible in normal UI, but keeping the
      // request claimed here also prevents programmatic/double sends from
      // slipping through while the first payload is awaiting a decision.
      if (pendingSendRef.current || openRef.current) {
        requestEvent.preventDefault();
        detail.settle('cancel');
        return;
      }
      if (promptedSessionsRef.current.has(sessionKey) || hasOpenModal()) return;

      requestEvent.preventDefault();
      pendingSendRef.current = { sessionKey, settle: detail.settle };
      setPendingRevision((value) => value + 1);
    };
    window.addEventListener(AMR_ARTIFACT_UPGRADE_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(AMR_ARTIFACT_UPGRADE_REQUEST_EVENT, handleRequest);
  }, [plan, planResolved, runtimeClass]);

  useEffect(() => {
    const pending = pendingSendRef.current;
    if (!pending) return;

    // Billing status can be unavailable while the Vela account remains
    // logged in. An unknown plan must never leave an intercepted Send hanging.
    // The runtime/preference re-checks cover a selection or preference change
    // racing the pause — a Send the gate no longer cares about continues.
    if (
      !planResolved
      || !isFreeAmrPlan(plan)
      || (runtimeClass === 'cli' && isAmrArtifactUpgradeCliIntroShown())
      || isAmrArtifactUpgradeOptedOut()
    ) {
      pendingSendRef.current = null;
      pending.settle('proceed');
      return;
    }

    // Another product-critical modal appearing between the click and the
    // resolved plan wins. Let the original Send continue instead of building
    // a surprise modal queue behind it.
    if (hasOpenModal()) {
      pendingSendRef.current = null;
      pending.settle('proceed');
      return;
    }

    // The dialog is really opening now — for a CLI-runtime user this IS the
    // one-time introduction, so burn the flag here and not any earlier: a
    // pass-through, a modal collision, or a plan flip must not consume it.
    if (runtimeClass === 'cli') setAmrArtifactUpgradeCliIntroShown();
    promptedSessionsRef.current.add(pending.sessionKey);
    openRef.current = true;
    setDialogSessionKey(pending.sessionKey);
  }, [pendingRevision, plan, planResolved, runtimeClass]);

  useEffect(() => {
    const previous = previousSurfaceRef.current;
    if (
      homeVisible
      && !previous.homeVisible
      && previous.offer
      && eligibleSessionsRef.current.has(previous.offer.sessionKey)
      && !homeOfferedSessionsRef.current.has(previous.offer.sessionKey)
    ) {
      setPendingHomeOffer(previous.offer);
    }
    previousSurfaceRef.current = {
      homeVisible,
      offer: homeOfferForRoute(
        activeProjectId,
        activeConversationId,
        activeFileName,
      ),
    };
  }, [activeConversationId, activeFileName, activeProjectId, homeVisible]);

  useEffect(() => {
    if (!pendingHomeOffer || !planResolved) return;
    // 'cloud' and 'api' contexts keep the normal per-session dedup. A 'cli'
    // context may use the card as its one-time introduction if the dialog
    // has not already been it — and only when a display surface is actually
    // wired up, so the mock review path can never burn the flag. The opt-out
    // silences every variant.
    const cliIntroAvailable =
      runtimeClass !== 'cli'
      || (onHomeOfferChange != null && !isAmrArtifactUpgradeCliIntroShown());
    if (
      isFreeAmrPlan(plan)
      && cliIntroAvailable
      && !isAmrArtifactUpgradeOptedOut()
      && !hasOpenModal()
    ) {
      if (runtimeClass === 'cli') setAmrArtifactUpgradeCliIntroShown();
      homeOfferedSessionsRef.current.add(pendingHomeOffer.sessionKey);
      promptedSessionsRef.current.add(pendingHomeOffer.sessionKey);
      onHomeOfferChange?.(pendingHomeOffer);
    }
    setPendingHomeOffer(null);
  }, [onHomeOfferChange, pendingHomeOffer, plan, planResolved, runtimeClass]);

  useEffect(() => {
    if (!planResolved || isFreeAmrPlan(plan)) return;
    onHomeOfferChange?.(null);
    if (!dialogSessionKey) return;
    const pending = pendingSendRef.current;
    pendingSendRef.current = null;
    pending?.settle('cancel');
    openRef.current = false;
    setDialogSessionKey(null);
  }, [dialogSessionKey, onHomeOfferChange, plan, planResolved]);

  useEffect(() => () => {
    const pending = pendingSendRef.current;
    pendingSendRef.current = null;
    pending?.settle('cancel');
  }, []);

  const settleDialog = (decision: AmrArtifactUpgradeDecision) => {
    const pending = pendingSendRef.current;
    pendingSendRef.current = null;
    pending?.settle(decision);
    openRef.current = false;
    setDialogSessionKey(null);
  };

  return dialogSessionKey ? (
    <AmrArtifactUpgradeDialog
      profile={profile}
      metricsConsent={metricsConsent}
      installationId={installationId}
      // A committed opt-out must also retract upsell state issued BEFORE the
      // commit: a home offer already handed to the app shell would otherwise
      // resurface on the next home visit despite the persisted preference.
      onOptOut={() => onHomeOfferChange?.(null)}
      onClose={() => settleDialog('cancel')}
      onContinue={() => settleDialog('proceed')}
    />
  ) : null;
}
