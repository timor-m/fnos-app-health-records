import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeDatabaseForTests } from "../database/client.ts";
import {
  canonicalMeasurementUnit,
  unitFromResultCell,
} from "../services/measurement-units.service.ts";

test("result cell units canonicalize OCR lookalike variants", () => {
  const directory = mkdtempSync(join(tmpdir(), "health-records-units-"));
  process.env.STORAGE_DIR = directory;
  try {
    /* f1 是 fL 的形近误读（数字 1 代替字母 l）；mmolL 是丢斜杠形态 */
    assert.equal(unitFromResultCell("82 f1"), "fL");
    assert.equal(unitFromResultCell("82 fL"), "fL");
    assert.equal(unitFromResultCell("82f1"), "fL");
    assert.equal(unitFromResultCell("5.30 mmolL"), "mmol/L");
    assert.equal(unitFromResultCell("5.30 mmol/L"), "mmol/L");
    /* 同类预设：数字 1/9 与字母 l/I/g 混淆 */
    assert.equal(unitFromResultCell("92 m1"), "mL");
    assert.equal(unitFromResultCell("13.2 p9"), "pg");
    assert.equal(unitFromResultCell("5.30 mmol/1"), "mmol/L");
    assert.equal(unitFromResultCell("310 mg/d1"), "mg/dL");
    assert.equal(unitFromResultCell("120 mmH9"), "mmHg");
    /* IU 族的 1U/L 形态在归一化层矫正，抽取层只负责完整取出 */
    assert.equal(unitFromResultCell("12 1U/L"), "1U/L");
    assert.equal(canonicalMeasurementUnit("f1"), "fL");
    assert.equal(canonicalMeasurementUnit("mg/d1"), "mg/dL");
    /* 规范写法幂等：含斜杠单位折叠后命中自身，fL 无斜杠不命中变体表 */
    assert.equal(canonicalMeasurementUnit("mmol/L"), "mmol/L");
    assert.equal(canonicalMeasurementUnit("fL"), null);
  } finally {
    closeDatabaseForTests();
    delete process.env.STORAGE_DIR;
    rmSync(directory, { recursive: true, force: true });
  }
});
