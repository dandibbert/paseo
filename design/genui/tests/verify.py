#!/usr/bin/env python3
"""Verify RFC/Skill example fixtures with the proposed JSON Schema + semantic checks.
Run: python tests/verify.py (requires jsonschema >= 4.18). The runtime must
implement equivalent validation in Zod; this script is only a design-fixture check.
"""
import json
import math
import re
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP
from jsonschema import Draft202012Validator

ROOT=Path(__file__).resolve().parents[1]

def reject_nonfinite(text):
 raise ValueError(f"non-finite JSON numeric literal: {text}")

def strict_load(text):
 return json.loads(text,parse_constant=reject_nonfinite)
S=strict_load((ROOT/'schemas/render-ui.v1.schema.json').read_text(encoding='utf-8'))
assert Draft202012Validator.check_schema(S) is None
validator=Draft202012Validator(S)
SUPPORTED={'metricComparison','metric','progress','chart.bar','chart.line','chart.pie','table','priorityList','card','grid'}

def semantic(d):
 typ=d['type']; data=d['data']
 if typ=='metricComparison':
  items={v['id']:v for v in data['items']}
  if len(items)!=len(data['items']): raise ValueError('duplicate comparison ids')
  comp=data['compare']; old=items[comp['from']]; new=items[comp['to']]
  if old.get('unit')!=new.get('unit'): raise ValueError('incompatible units')
  if comp['from']==comp['to']: raise ValueError('identical comparisons')
  if old['value']!=0:
   x=(Decimal(str(new['value']))-Decimal(str(old['value'])))/Decimal(str(old['value']))*100
   p=comp.get('precision',1)
   change=float(x.quantize(Decimal('1').scaleb(-p),rounding=ROUND_HALF_UP))
   return {'changePercent':change}
  return {'unavailableReason':'zero_baseline'}
 if typ in ('chart.bar','chart.line'):
  for series in data['series']:
   if series['field']==data['x']: raise ValueError('series uses x field')
  for row in data['rows']:
   if data['x'] not in row or row[data['x']] is None: raise ValueError('missing x value')
   for s in data['series']:
    if s['field'] not in row: raise ValueError('missing series field')
    val=row[s['field']]
    if val is not None and (type(val) not in [int,float]): raise ValueError('non-numeric series value')
 if typ=='chart.pie':
  total=0
  for row in data['rows']:
   lab=row.get(data['labelField']); val=row.get(data['valueField'])
   if not isinstance(lab,str) or not lab.strip(): raise ValueError('invalid label')
   if type(val) not in (int,float) or val<0: raise ValueError('invalid pie value')
   total+=val
  if total<=0: raise ValueError('pie total zero')
  if data.get('unit')=='%' and abs(total-100)>0.11: raise ValueError('percent pie not 100%')
 if typ=='table':
  fields=[c['field'] for c in data['columns']]
  if len(fields)!=len(set(fields)): raise ValueError('duplicate table field')
  for row in data['rows']:
   if not all(k in row for k in fields): raise ValueError('missing table cell')
 if typ in ('card','grid'):
  for ch in data['children']:
   semantic(ch)
 return None

for path in sorted((ROOT/'tests/fixtures').glob('*.json')):
 d=strict_load(path.read_text(encoding='utf-8'))
 validator.validate(d)
 semantic(d)
 print('OK',path.name,d['type'])
assert {json.loads(p.read_text())['type'] for p in (ROOT/'tests/fixtures').glob('*.json')}==SUPPORTED
cases=strict_load((ROOT/'tests/generation-cases.json').read_text(encoding='utf-8'))
assert len(cases['cases'])==20
assert cases['cases'][5]['id']=='T06' and '应要求' not in cases['cases'][5]['assertion']
assert cases['cases'][11]['id']=='T12' and cases['cases'][11]['preferred_type']=='chart.pie'
assert cases['cases'][19]['id']=='T20' and ('不得要求不存在的附件' in cases['cases'][19]['assertion'])
# Validate all hand-authored full JSON tool-call examples in Markdown.
for refpath in [ROOT/'skills/paseo-genui/references/components.md', ROOT/'skills/paseo-genui/references/golden-examples.md', ROOT/'docs/genui-generation-guidelines.md', ROOT/'docs/genui-rfc-v0.4.md']:
 for snippet in re.findall(r'```json\s*\n(.*?)\n```', refpath.read_text(encoding='utf8'), flags=re.S):
  example=strict_load(snippet)
  if 'data' in example and 'type' in example:
   validator.validate(example)
   semantic(example)
# Future additions must not reintroduce the stale priority level field in actual fixtures.
for path in (ROOT/'tests/fixtures').glob('*.json'):
 assert '"level"' not in path.read_text(encoding='utf8')
# v0.4 cross-file consistency checks.
ref_a=strict_load((ROOT/'tests/fixtures/reference-a.json').read_text(encoding='utf-8'))
assert ref_a['data']['compare'].get('changeIntent')=='bad', 'reference A must declare changeIntent=bad'
by_id={c['id']:c for c in cases['cases']}
assert '"bad"' in by_id['T03']['assertion'], 'T03 must require changeIntent=bad'
assert '"good"' in by_id['T14']['assertion'] and '不得填 "bad"' in by_id['T14']['assertion'], 'T14 must forbid changeIntent=bad'
def min_format_table(text):
 out=[]; on=False
 for line in text.split('\n'):
  line=line.strip()
  if re.match(r'^\|\s*type\s*\|',line): on=True
  if on:
   if not line.startswith('|'): break
   cells=[c.strip() for c in re.split(r'(?<!\\)\|',line)[1:-1]]
   if all(set(c)<=set('-: ') for c in cells): continue
   out.append(cells)
 return out
skill_table=min_format_table((ROOT/'skills/paseo-genui/SKILL.md').read_text(encoding='utf-8'))
rfc_table=min_format_table((ROOT/'docs/genui-rfc-v0.4.md').read_text(encoding='utf-8'))
assert skill_table and skill_table==rfc_table, 'RFC 5.1 min-format table must match SKILL.md verbatim'
assert {row[0].strip('`') for row in skill_table[1:]}==SUPPORTED, 'min-format table must list exactly the v1 types'
for doc in (ROOT/'docs').glob('*.md'):
 text=doc.read_text(encoding='utf-8')
 assert 'RFC v0.2.1' not in text, f'stale RFC reference in {doc.name}'
 assert 'genui-visual-quality.md' not in text or doc.name=='genui-rfc-v0.4.md' or doc.name=='genui-visual-acceptance.md', f'stale visual doc reference in {doc.name}'
print('PASS: 10 component fixtures + 20 behavior cases + Markdown JSON examples + v0.4 cross-file checks')
