export class EngineFailure extends Error {
  readonly what: string;

  constructor(what: string) {
    super(what);
    this.name = "EngineFailure";
    this.what = what;
  }
}
