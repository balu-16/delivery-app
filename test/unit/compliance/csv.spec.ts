import { csvLine } from '../../../src/modules/compliance/domain/csv.js';
it('quotes fields and neutralizes formulas even behind whitespace without changing typed numbers', () => {
  expect(
    csvLine(['a,"b', '  =HYPERLINK("bad")', '\tcmd', '+1+2', '-1+2', '@SUM(A1)', 12, -12, null]),
  ).toBe(
    '"a,""b","\'  =HYPERLINK(""bad"")","\'\tcmd","\'+1+2","\'-1+2","\'@SUM(A1)","12","-12",""\r\n',
  );
  expect(csvLine([{ ok: true }, false, 2n, undefined])).toBe('"{""ok"":true}","false","2",""\r\n');
});
