import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classify,
  createResponse,
  createError,
  ERROR_CODES,
} from '../src/protocol/jsonrpc.js'

test('classify 识别请求/通知/响应', () => {
  assert.equal(classify({ jsonrpc: '2.0', id: 1, method: 'ping' }), 'request')
  assert.equal(classify({ jsonrpc: '2.0', method: 'ping' }), 'notification')
  assert.equal(classify({ jsonrpc: '2.0', id: 1, result: {} }), 'response')
  assert.equal(classify({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'x' } }), 'response')
})

test('classify 拒绝畸形消息', () => {
  assert.equal(classify(null), 'invalid')
  assert.equal(classify({}), 'invalid')
  assert.equal(classify({ jsonrpc: '1.0', id: 1, method: 'ping' }), 'invalid')
  assert.equal(classify({ jsonrpc: '2.0', id: 1 }), 'invalid')
  assert.equal(classify('hello'), 'invalid')
  // method 与 result/error 冲突
  assert.equal(classify({ jsonrpc: '2.0', id: 1, method: 'ping', result: {} }), 'invalid')
  assert.equal(classify({ jsonrpc: '2.0', id: 1, method: 'ping', error: { code: 1, message: 'x' } }), 'invalid')
})

test('createResponse 与 createError 遵循 JSON-RPC 2.0 形状', () => {
  assert.deepEqual(createResponse(7, { ok: true }), {
    jsonrpc: '2.0',
    id: 7,
    result: { ok: true },
  })
  assert.deepEqual(createError(7, ERROR_CODES.METHOD_NOT_FOUND, '未知方法'), {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32601, message: '未知方法' },
  })
})

test('错误码与规范一致', () => {
  assert.equal(ERROR_CODES.PARSE_ERROR, -32700)
  assert.equal(ERROR_CODES.INVALID_REQUEST, -32600)
  assert.equal(ERROR_CODES.METHOD_NOT_FOUND, -32601)
  assert.equal(ERROR_CODES.INVALID_PARAMS, -32602)
  assert.equal(ERROR_CODES.INTERNAL_ERROR, -32603)
})
