/// <reference types="jest" />
import { en } from "../src/locales/en";
import { te } from "../src/locales/te";
import { hi } from "../src/locales/hi";
import { kn } from "../src/locales/kn";
import { translate } from "../src/i18n";
test("each language contains the same phrases", () => {
  for (const locale of [te, hi, kn])
    expect(Object.keys(locale).sort()).toEqual(Object.keys(en).sort());
  expect(translate("Complete delivery", "te")).not.toBe("Complete delivery");
  expect(translate("Complete delivery", "en")).toBe("Complete delivery");
});
