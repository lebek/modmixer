// proper-lockfile is reachable transitively via pi-mono but ships no types.
// We use only the lockSync / lock APIs in `secure-auth-storage.ts`; this
// minimal shape covers them.
declare module 'proper-lockfile' {
  interface LockOptions {
    realpath?: boolean;
    retries?:
      | number
      | {
          retries: number;
          factor?: number;
          minTimeout?: number;
          maxTimeout?: number;
          randomize?: boolean;
        };
    stale?: number;
    onCompromised?: (err: Error) => void;
  }
  export function lockSync(file: string, opts?: LockOptions): () => void;
  export function lock(
    file: string,
    opts?: LockOptions,
  ): Promise<() => Promise<void>>;
  const _default: { lockSync: typeof lockSync; lock: typeof lock };
  export default _default;
}
