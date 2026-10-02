/** Remotion's webpack serves a bundled font file as a URL (asset/resource). */
declare module "*.ttf" {
  const url: string;
  export default url;
}
