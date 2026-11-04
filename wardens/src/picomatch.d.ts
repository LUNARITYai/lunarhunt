declare module "picomatch" {
  interface Options {
    dot?: boolean;
  }

  interface Picomatch {
    (glob: string, options?: Options): (input: string) => boolean;
    isMatch(input: string, glob: string, options?: Options): boolean;
  }

  const picomatch: Picomatch;
  export default picomatch;
}
