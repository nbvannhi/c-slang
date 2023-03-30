import {
  ArrayExpression,
  AssignmentOperator,
  BigIntLiteral,
  Identifier,
  MemberExpression,
  Pattern,
  SequenceExpression,
  UpdateOperator
} from 'estree'

import { getCurrentFrame, getGlobalFrame, lookupFrame, updateFrame } from '../environment'
import { actualValue, evaluate } from '../interpreter/interpreter'
import { Kind, toKind } from '../types'

export function* evaluateArrayExpression(node: ArrayExpression, context: any) {
  // TODO: handle array access
  return undefined
}

export function evaluateFunctionExpression(params: Array<Pattern>, body: any) {
  params.forEach(p => p as MemberExpression)
  const value = {
    params: params,
    body: body
  }
  return value
}

export function* evaluateCallExpression(
  name: any,
  params: any,
  body: any,
  args: any,
  context: any
) {
  const global = getGlobalFrame(context)
  if (global && global[name]) {
    const kind = global[name].kind
    const frame = getCurrentFrame(context)
    for (const param of params) {
      const name = (param.object as Identifier).name
      const kind = toKind(param.property as BigIntLiteral)
      const arg = evaluateCastExpression(args.shift(), kind)
      updateFrame(frame, name, kind, arg)
    }

    let result = yield* evaluate(body, context)
    result = evaluateCastExpression(result, kind)
    if (context.prelude === 'return') {
      context.prelude = null
    }
    return result
  }
}

export function* evaluateSequenceExpression(node: SequenceExpression, context: any) {
  let result
  for (const expression of node.expressions) {
    result = yield* evaluate(expression, context)
  }
  return result
}

export function* evaluateConditionalExpression(
  test: any,
  alternate: any,
  consequent: any,
  context: any
) {
  const result = test
    ? yield* actualValue(consequent, context)
    : yield* actualValue(alternate, context)
  return result
}

const assignmentMicrocode = {
  '=': (l: any, r: any) => r,
  '+=': (l: any, r: any) => l + r,
  '-=': (l: any, r: any) => l - r,
  '*=': (l: any, r: any) => l * r,
  '/=': (l: any, r: any) => l / r,
  '%=': (l: any, r: any) => l % r
}

export function* evaluateAssignmentExpression(
  operator: AssignmentOperator,
  left: any,
  right: any,
  context: any
) {
  // TODO: handle non-identifier
  const name = left.name
  const lhs = yield* actualValue(left, context)
  let rhs = yield* actualValue(right, context)
  const frame = lookupFrame(context, name)
  if (frame) {
    const id = frame[name]
    const kind = id.kind
    rhs = evaluateCastExpression(rhs, kind)
    const value = assignmentMicrocode[operator](lhs, rhs)
    updateFrame(frame, name, kind, value)
    return value
  }
}

const updateMicrocode = {
  '++': (v: any) => ++v,
  '--': (v: any) => --v
}

export function* evaluateUpdateExpression(
  operator: UpdateOperator,
  argument: any,
  prefix: any,
  context: any
) {
  // TODO: handle non-identifier
  const name = argument.name
  const before = yield* actualValue(argument, context)
  const after = updateMicrocode[operator](before)
  const frame = lookupFrame(context, name)
  if (frame) {
    const id = frame[name]
    updateFrame(frame, name, id.kind, after)
    return prefix ? after : before
  }
}

export function evaluateCastExpression(value: any, kind: Kind) {
  // (float) [int *] is still valid in this implementation
  const valueInt = Number.isInteger(value)
  const valid = !kind.pointers || valueInt
  if (!valid) {
    const prim = kind.primitive.toString()
    const ptr = kind.pointers ? ' ' + '*'.repeat(kind.pointers) : ''
    const type = prim + ptr
    throw new Error(`incompatible types when casting to type ${type}`)
  }
  return valueInt || kind.primitive === 'float' ? value : Math.trunc(value)
}
