// A password file contains one line, optionally terminated by LF or CRLF.
export function parsePasswordFile(contents: string): string {
  const password = contents.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(password))
    throw new Error("Password file must contain a single line.");
  return password;
}
