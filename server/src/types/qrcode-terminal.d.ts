declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean;
  }
  export function generate(text: string, opts?: Options, callback?: (qr: string) => void): void;
}
