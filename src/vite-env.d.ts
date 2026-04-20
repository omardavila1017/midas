/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_MAX_UPLOAD_SIZE_MB?: string;
  readonly VITE_SUPPORTED_FORMATS?: string;
  readonly VITE_JDE_BASE_URL?: string;
  readonly VITE_JDE_UPSTREAM?: string;
  readonly VITE_JDE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
