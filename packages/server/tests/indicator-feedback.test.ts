import assert from 'node:assert/strict';
import test from 'node:test';
import {buildIndicatorFeedbackText,sanitizeIndicatorFeedbackName,validateIndicatorFeedbackNames} from '../../ui/src/utils/indicator-feedback';

test('indicator requests normalize and deduplicate names without discarding invalid entries silently',()=>{
  assert.equal(sanitizeIndicatorFeedbackName('  合成\n指标甲  '),'合成 指标甲');
  assert.deepEqual(validateIndicatorFeedbackNames([' 合成指标甲 ','合成指标甲','ＳＤＬＤＬ','sdldl']),['合成指标甲','SDLDL']);
  for(const name of ['联系电话 13800138000','证件 440101199001011234','user@example.com','合成指标甲 | 7 | U/L','合成指标甲 7.2','合成指标甲7.2','合成指标甲 7 U/L','合成指标甲 7%','合成指标甲 阳性','姓名：合成用户','合成医院检测项目']) {
    assert.equal(sanitizeIndicatorFeedbackName(name),null);
    assert.throws(()=>validateIndicatorFeedbackNames(['合成指标甲',name]),/本地核对/);
  }
});

test('medical name numbers remain usable while count and content length are bounded',()=>{
  for(const name of ['CA 125','糖类抗原 125','维生素 B12','补体 C3','CD4+','25 羟维生素D','1,25-二羟维生素D','糖化血红蛋白HbA1c']) assert.equal(sanitizeIndicatorFeedbackName(name),name);
  for(const value of [undefined,{},[],[1],Array(41).fill('合成指标甲')]) assert.throws(()=>validateIndicatorFeedbackNames(value));
  const longNames=Array.from({length:40},(_,i)=>'合成指标'.repeat(20)+String.fromCharCode(0x4e00+i));
  assert.throws(()=>buildIndicatorFeedbackText(longNames),/3000/);
  assert.equal(buildIndicatorFeedbackText([]),'');
});

test('generated request text contains names and necessary versions only',()=>{
  const text=buildIndicatorFeedbackText(['合成指标甲','合成指标甲','合成指标乙'],{appVersion:'0.2.15',schemaVersion:19,dictionaryVersion:'core-r1+remote-r2'});
  assert.match(text,/指标字典收录申请（2 项）/);
  assert.equal(text.match(/- 合成指标甲/g)?.length,1);
  assert.match(text,/数据库：v19/);assert.match(text,/core-r1\+remote-r2/);
  assert.doesNotMatch(text,/github\.com|https?:\/\//);
});
