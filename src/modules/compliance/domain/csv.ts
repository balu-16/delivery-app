/** Treat every textual field as untrusted, including whitespace before formulas. */
export function csvLine(values: readonly unknown[]): string {
  return (
    values
      .map((value) => {
        let text =
          value === null || value === undefined
            ? ''
            : typeof value === 'object'
              ? JSON.stringify(value)
              : String(value);
        if (
          typeof value !== 'number' &&
          typeof value !== 'bigint' &&
          (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
        )
          text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
      })
      .join(',') + '\r\n'
  );
}
