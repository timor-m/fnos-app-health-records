import { readFileSync,readdirSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { expect,it } from 'vitest';

const sourceRoot=resolve('packages/ui/src');
function styleSources(directory=sourceRoot):Array<{file:string;css:string}> {
 return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  const file=join(directory,entry.name);if(entry.isDirectory())return styleSources(file);
  if(!/\.(css|vue)$/.test(file))return [];
  const source=readFileSync(file,'utf8');return [{file,css:file.endsWith('.css')?source:[...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(match=>match[1]).join('\n')}];
 });
}

it('does not reintroduce intermediate 13px or 15px text sizes through page or component overrides',()=>{
 const invalid=styleSources().filter(({css})=>/font-size:\s*(?:13|15)px\b/.test(css)).map(({file})=>file);
 expect(invalid).toEqual([]);
});

it('keeps editable values, select options and date wheels at 14px even in compact or touch overrides',()=>{
 const control=/(?:^|[\s>+~,(])(?:input|textarea|select)\b|\.form-select-(?:trigger|option)\b|\.datetime-wheel-item\b/;
 const rules=styleSources().flatMap(({file,css})=>[...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].flatMap(([,selector,body])=>{
  if(!control.test(selector))return [];
  const size=/font-size:\s*([^;\n}]+)/.exec(body)?.[1].trim();return size?[{file,selector:selector.trim(),size}]:[];
 }));
 expect(rules.length).toBeGreaterThan(30);expect(rules.filter(rule=>rule.size!=='14px')).toEqual([]);
 const picker=readFileSync(join(sourceRoot,'components/DateTimePicker.css'),'utf8');
 expect(picker).toMatch(/\.datetime-wheel-item\.selected\s*\{[^}]*transform:\s*none/);
});
