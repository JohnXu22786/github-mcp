import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry, validateArgs } from '../src/tools/registry.js'
import { RepogateError } from '../src/core/errors.js'

const echoTool = {
  name: 'echo',
  description: '原样返回参数',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '文本' },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      mode: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' } },
      flag: { type: 'boolean' },
    },
    required: ['text'],
  },
  execute: async (args) => ({ args }),
}

const writeTool = {
  name: 'do_write',
  description: '写操作',
  mutating: true,
  inputSchema: { type: 'object', properties: {}, required: [] },
  execute: async () => ({ done: true }),
}

const services = { config: { readOnly: false } }

test('校验通过：合法参数可执行', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  const out = await r.call('echo', { text: 'hi', count: 3, mode: 'a', tags: ['x', 'y'], flag: true }, services)
  assert.equal(out.args.text, 'hi')
})

test('缺失必填参数 → ValidationError，消息含字段名', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  await assert.rejects(() => r.call('echo', {}, services), (err) => {
    assert.ok(err instanceof RepogateError)
    assert.equal(err.code, 'validation')
    assert.match(err.message, /text/)
    return true
  })
})

test('类型不符 → ValidationError', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  await assert.rejects(() => r.call('echo', { text: 42 }, services), (err) => {
    assert.match(err.message, /字符串/)
    return true
  })
})

test('enum 越界 → ValidationError', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  await assert.rejects(() => r.call('echo', { text: 'x', mode: 'zzz' }, services), (err) => {
    assert.match(err.message, /mode/)
    return true
  })
})

test('整数边界：最小值与最大值', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  await assert.rejects(() => r.call('echo', { text: 'x', count: 0 }, services))
  await assert.rejects(() => r.call('echo', { text: 'x', count: 11 }, services))
  await assert.rejects(() => r.call('echo', { text: 'x', count: 1.5 }, services))
  const ok = await r.call('echo', { text: 'x', count: 10 }, services)
  assert.equal(ok.args.count, 10)
})

test('数组元素类型校验', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  await assert.rejects(() => r.call('echo', { text: 'x', tags: [1, 2] }, services), (err) => {
    assert.match(err.message, /tags/)
    return true
  })
})

test('未知键忽略，不报错', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  const out = await r.call('echo', { text: 'x', extra: 123 }, services)
  assert.equal(out.args.text, 'x')
})

test('非对象参数（数组）→ ValidationError', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  await assert.rejects(() => r.call('echo', [1, 2], services), (err) => {
    assert.equal(err.code, 'validation')
    return true
  })
})

test('缺省参数视为空对象', async () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  await assert.rejects(() => r.call('echo', undefined, services))
})

test('只读模式下变更类工具被拦截', async () => {
  const r = new ToolRegistry()
  r.register(writeTool)
  await assert.rejects(() => r.call('do_write', {}, { config: { readOnly: true } }), (err) => {
    assert.ok(err instanceof RepogateError)
    assert.equal(err.code, 'readonly')
    assert.match(err.message, /只读/)
    return true
  })
  const ok = await r.call('do_write', {}, { config: { readOnly: false } })
  assert.equal(ok.done, true)
})

test('未知工具 → ValidationError', async () => {
  const r = new ToolRegistry()
  await assert.rejects(() => r.call('ghost', {}, services), (err) => {
    assert.equal(err.code, 'validation')
    assert.match(err.message, /ghost/)
    return true
  })
})

test('重复注册同名工具 → 报错', () => {
  const r = new ToolRegistry()
  r.register(echoTool)
  assert.throws(() => r.register(echoTool), RepogateError)
})

test('validateArgs 直接用法', () => {
  const schema = {
    type: 'object',
    properties: { n: { type: 'integer', minimum: 0 } },
    required: ['n'],
  }
  assert.deepEqual(validateArgs({ n: 5 }, schema, 't'), { n: 5 })
  assert.throws(() => validateArgs({}, schema, 't'), RepogateError)
})
