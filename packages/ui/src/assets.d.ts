// Bundlers resolve an imported SVG to its URL, as Vite does for the client.
declare module "*.svg" {
  const url: string;
  export default url;
}
