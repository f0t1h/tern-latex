// pdfjs-dist ships no typings for its worker module; render.ts only hands it back to pdf.js.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
