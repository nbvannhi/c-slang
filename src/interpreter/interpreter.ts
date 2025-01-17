/* tslint:disable:max-classes-per-file */
import * as es from 'estree'

import {
  extendEnvironment,
  getCurrentEnvironment,
  getGlobalEnvironment,
  peekCallback,
  peekEnvironment,
  popCallback,
  popEnvironment,
  pushCallback,
  pushEnvironment
} from '../environment'
import { RuntimeSourceError } from '../errors/runtimeSourceError'
import {
  evaluateFunctionDeclaration,
  evaluateVariableDeclaration
} from '../evaluators/declarations'
import {
  evaluateArrayAccessExpression,
  evaluateArrayExpression,
  evaluateAssignmentExpression,
  evaluateCallExpression,
  evaluateCastExpression,
  evaluateConditionalExpression,
  evaluateFunctionExpression,
  evaluateIdentifer,
  evaluateSequenceExpression,
  evaluateUpdateExpression
} from '../evaluators/expressions'
import {
  evaluateBinaryExpression,
  evaluateLogicalExpression,
  evaluateUnaryExpression
} from '../evaluators/operators'
import {
  evaluateBlockSatement,
  evaluateDoWhileStatement,
  evaluateForStatement,
  evaluateIfStatement,
  evaluateReturnStatement,
  evaluateWhileStatement
} from '../evaluators/statements'
import { Context, Environment, Kind, toKind, Value } from '../types'

class Thunk {
  public value: Value
  public isMemoized: boolean
  constructor(public exp: es.Node, public env: Environment) {
    this.isMemoized = false
    this.value = null
  }
}

export function* forceIt(val: any, context: Context): Value {
  if (val instanceof Thunk) {
    if (val.isMemoized) return val.value

    pushEnvironment(context, val.env)
    const evalRes = yield* actualValue(val.exp, context)
    popEnvironment(context)
    val.value = evalRes
    val.isMemoized = true
    return evalRes
  } else return val
}

export function* actualValue(exp: es.Node, context: Context): Value {
  const evalResult = yield* evaluate(exp, context)
  const forced = yield* forceIt(evalResult, context)
  return forced
}

const handleRuntimeError = (context: Context, error: RuntimeSourceError): never => {
  context.errors.push(error)
  context.runtime.environments = context.runtime.environments.slice(
    -context.numberOfOuterEnvironments
  )
  throw error
}

function* visit(context: Context, node: es.Node) {
  context.runtime.nodes.unshift(node)
  yield context
}

function* leave(context: Context) {
  context.runtime.break = false
  context.runtime.nodes.shift()
  yield context
}

export type Evaluator<T extends es.Node> = (node: T, context: Context) => IterableIterator<Value>

/**
 * WARNING: Do not use object literal shorthands, e.g.
 *   {
 *     *Literal(node: es.Literal, ...) {...},
 *     *ThisExpression(node: es.ThisExpression, ..._ {...},
 *     ...
 *   }
 * They do not minify well, raising uncaught syntax errors in production.
 * See: https://github.com/webpack/webpack/issues/7566
 */
// tslint:disable:object-literal-shorthand
// prettier-ignore
export const evaluators: { [nodeType: string]: Evaluator<es.Node> } = {
  /** Simple Values */
  Literal: function* (node: es.Literal, _context: Context) {
    return node.value
  },

  ArrayExpression: function* (node: es.ArrayExpression, context: Context) {
    const elements = node.elements
    return yield* evaluateArrayExpression(elements, context)
  },

  FunctionExpression: function* (node: es.FunctionExpression, context: Context) {
    const params = node.params
    const body = node.body
    return evaluateFunctionExpression(params, body)
  },

  Identifier: function* (node: es.Identifier, context: Context) {
    return evaluateIdentifer(node.name, context)
  },

  CallExpression: function* (node: es.CallExpression, context: Context) {
    const callee = node.callee as es.Identifier
    const name = callee.name
    const value = yield* actualValue(callee, context)
    const args = []
    for (const arg of node.arguments) {
      args.push(yield* actualValue(arg, context))
    }

    context.prelude = name
    const current = getCurrentEnvironment(context)
    const global = getGlobalEnvironment(context)
    const env = extendEnvironment(context, context.prelude, global)
    pushCallback(context, current)
    pushEnvironment(context, env)
    const result = yield* evaluateCallExpression(name, value.params, value.body, args, context)
    popCallback(context)
    popEnvironment(context, env.id)
    context.prelude = null
    return result
  },

  SequenceExpression: function* (node: es.SequenceExpression, context: Context) {
    const result = yield* forceIt(yield* evaluateSequenceExpression(node, context), context)
    return result
  },

  UnaryExpression: function* (node: es.UnaryExpression, context: Context) {
    return yield* evaluateUnaryExpression(node.operator, node.argument, context)
  },

  BinaryExpression: function* (node: es.BinaryExpression, context: Context) {
    const left = yield* actualValue(node.left, context)
    const right = yield* actualValue(node.right, context)
    return evaluateBinaryExpression(node.operator, left, right)
  },

  ConditionalExpression: function* (node: es.ConditionalExpression, context: Context) {
    const test = yield* actualValue(node.test, context)
    return yield* evaluateConditionalExpression(test, node.alternate, node.consequent, context)
  },

  LogicalExpression: function* (node: es.LogicalExpression, context: Context) {
    const left = yield* actualValue(node.left, context)
    return yield* evaluateLogicalExpression(node.operator, left, node.right, context)
  },

  MemberExpression: function* (node: es.MemberExpression, context: Context) {
    const isCast = !node.computed
    if (isCast) {
      const value = yield* actualValue(node.object, context)
      const kind = toKind(node.property as es.BigIntLiteral)
      return evaluateCastExpression(value, kind)
    } else {
      const expression = yield* actualValue(node.object, context)
      const index = yield* actualValue(node.property, context)
      return yield* evaluateArrayAccessExpression(expression, index, context)
    }
  },

  VariableDeclaration: function* (node: es.VariableDeclaration, context: Context) {
    return yield* evaluateVariableDeclaration(node, context)
  },

  ContinueStatement: function* (_node: es.ContinueStatement, _context: Context) {
    while (peekEnvironment(_context).name === 'default') {
      popEnvironment(_context)
    }
    _context.prelude = 'continue'
  },

  BreakStatement: function* (_node: es.BreakStatement, _context: Context) {
    while (peekEnvironment(_context).name === 'default') {
      popEnvironment(_context)
    }
    popEnvironment(_context)
    _context.prelude = 'break'
  },

  ForStatement: function* (node: es.ForStatement, context: Context) {
    context.prelude = 'for'
    const env = extendEnvironment(context, context.prelude)
    pushEnvironment(context, env)
    const result = yield* evaluateForStatement(node, context)
    popEnvironment(context, env.id)
    context.prelude = null
    return result
  },

  AssignmentExpression: function* (node: es.AssignmentExpression, context: Context) {
    return yield* evaluateAssignmentExpression(node.operator, node.left, node.right, context)
  },

  UpdateExpression: function* (node: es.UpdateExpression, context: Context) {
    return yield* evaluateUpdateExpression(node.operator, node.argument, node.prefix, context)
  },

  FunctionDeclaration: function* (node: es.FunctionDeclaration, context: Context) {
    return yield evaluateFunctionDeclaration(node, context)
  },

  IfStatement: function* (node: es.IfStatement, context: Context) {
    const test = yield* actualValue(node.test, context)
    return yield* evaluateIfStatement(test, node.consequent, node.alternate, context)
  },

  ExpressionStatement: function* (node: es.ExpressionStatement, context: Context) {
    return yield* evaluate(node.expression, context)
  },

  ReturnStatement: function* (node: es.ReturnStatement, context: Context) {
    const result = yield* evaluateReturnStatement(node, context)
    while (peekEnvironment(context).id !== peekCallback(context)?.id) {
      popEnvironment(context)
    }
    context.prelude = 'return'
    return result
  },

  WhileStatement: function* (node: es.WhileStatement, context: Context) {
    context.prelude = 'while'
    const result = yield* evaluateWhileStatement(node, context)
    context.prelude = null
    return result
  },

  DoWhileStatement: function* (node: es.DoWhileStatement, context: Context) {
    context.prelude = 'do-while'
    const result = yield* evaluateDoWhileStatement(node, context)
    context.prelude = null
    return result
  },

  BlockStatement: function* (node: es.BlockStatement, context: Context) {
    const env = extendEnvironment(context, context.prelude)
    pushEnvironment(context, env)
    const result = yield* forceIt(yield* evaluateBlockSatement(node, context), context)
    popEnvironment(context, env.id)
    return result
  },

  Program: function* (node: es.Program, context: Context) {
    const result = yield* forceIt(yield* evaluateBlockSatement(node, context), context)
    return result
  }
}
// tslint:enable:object-literal-shorthand

export function* evaluate(node: es.Node, context: Context) {
  try {
    const result = yield* evaluators[node.type](node, context)
    yield* leave(context)
    return result
  } catch (error) {
    console.log(`${error.name}: ${error.message}\n${error.stack}`)
  }
}
