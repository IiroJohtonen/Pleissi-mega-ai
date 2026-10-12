/// <reference types="vite/client" />

interface ImportMetaEnv {
  // Rajapinnan osoite, jos se ei ole oletus (kehityksessä http://localhost:4000/api, tuotannossa /api).
  readonly VITE_API_URL?: string;
}
