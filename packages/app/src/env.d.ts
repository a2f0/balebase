/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_URL?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_WEBSITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface PlaidLinkMetadata {
  institution: {
    institution_id: string | null;
    name: string | null;
  } | null;
  link_session_id?: string | null;
}

interface PlaidLinkError {
  display_message?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  error_type?: string | null;
}

interface PlaidLinkExitMetadata {
  institution?: {
    institution_id: string | null;
    name: string | null;
  } | null;
  link_session_id?: string | null;
  request_id?: string | null;
  status?: string | null;
}

interface PlaidLinkEventMetadata {
  error_code?: string | null;
  error_message?: string | null;
  error_type?: string | null;
  exit_status?: string | null;
  request_id?: string | null;
  timestamp?: string | null;
  view_name?: string | null;
}

interface PlaidLinkHandler {
  destroy: () => void;
  open: () => void;
}

interface Window {
  Plaid?: {
    create: (configuration: {
      onEvent?: (eventName: string, metadata: PlaidLinkEventMetadata) => void;
      onExit: (
        error: PlaidLinkError | null,
        metadata: PlaidLinkExitMetadata,
      ) => void;
      onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
      receivedRedirectUri?: string;
      token: string;
    }) => PlaidLinkHandler;
  };
}
