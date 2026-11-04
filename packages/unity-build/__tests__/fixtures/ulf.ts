/** Minimal .ulf: DeveloperData is base64 of 4 bytes + the serial. */
export const ulf = (serial: string, stopDate = ''): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?><root><License id="Terms">',
    `<DeveloperData Value="${Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from(serial)]).toString('base64')}"/>`,
    '<StartDate Value="2024-01-01T00:00:00"/>',
    `<StopDate Value="${stopDate}"/>`,
    '</License></root>'
  ].join('\n')
