/// <reference types="vite/client" />

import 'react';

declare module 'react' {
  interface ImgHTMLAttributes<T> {
    fetchpriority?: 'high' | 'low' | 'auto';
  }
}

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_MAX_UPLOAD_SIZE_MB?: string;
  readonly VITE_SUPPORTED_FORMATS?: string;
  readonly VITE_ATLAS_ARTIFACT_ID?: string;
  readonly VITE_JDE_BASE_URL?: string;
  readonly VITE_JDE_UPSTREAM?: string;
  readonly VITE_JDE_TOKEN?: string;
  readonly VITE_JDE_ENVIRONMENT?: string;
  readonly VITE_CITI_BASE_URL?: string;
  readonly VITE_CITI_UPSTREAM?: string;
  readonly VITE_OPENAI_BASE_URL?: string;
  readonly VITE_OPENAI_MODEL?: string;
  readonly VITE_ENABLE_LOCAL_AUTH_GATE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
