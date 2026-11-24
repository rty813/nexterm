// Static assets imported by bundled code resolve to their URL (Vite).
declare module "*.svg" {
  const url: string;
  export default url;
}
