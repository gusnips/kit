/**
 * Two lint rules our apps each wrote as an ESLint `no-restricted-syntax` selector. oxlint 1.93 has no
 * `no-restricted-syntax`, so they live here as a plugin. Neither rule is on in `base.json` or
 * `react.json`: a repo asks for them (see the README), so moving to a new version of the presets
 * never adds findings by itself.
 *
 * Both match exactly what the selectors matched, so a repo that moves from the selectors to these
 * rules keeps the findings it had:
 *
 *   TSAsExpression > TSAsExpression.expression[typeAnnotation.type="TSUnknownKeyword"]
 *   CallExpression[callee.name=/^use(Layout|Insertion)?Effect$/] > ArrowFunctionExpression
 *     [body.type!="BlockStatement"][body.type!="ArrowFunctionExpression"][body.type!="FunctionExpression"]
 */

const EFFECT_HOOK = /^use(Layout|Insertion)?Effect$/;

// A body that is itself a function is a cleanup on purpose, so it is not reported.
const BODIES_THAT_ARE_FINE = new Set([
  "BlockStatement",
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

const noAsUnknownAs = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `x as unknown as T`. A cast through `unknown` tells the compiler to stop checking.",
    },
    messages: {
      doubleCast: "No `as unknown as T`. Fix the underlying type mismatch instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      TSAsExpression(node) {
        const inner = node.expression;
        // Reported on the inner `x as unknown`, where the selector matched.
        if (inner.type === "TSAsExpression" && inner.typeAnnotation.type === "TSUnknownKeyword")
          context.report({ node: inner, messageId: "doubleCast" });
      },
    };
  },
};

const effectBodyMustBeBlock = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a block body on the function passed to useEffect, useLayoutEffect and useInsertionEffect.",
    },
    messages: {
      block:
        "An effect body must be a block. A concise arrow body returns its value, and React calls that value as the cleanup.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || !EFFECT_HOOK.test(node.callee.name)) return;
        for (const argument of node.arguments)
          if (
            argument.type === "ArrowFunctionExpression" &&
            !BODIES_THAT_ARE_FINE.has(argument.body.type)
          )
            context.report({ node: argument, messageId: "block" });
      },
    };
  },
};

export default {
  meta: { name: "gusnips" },
  rules: {
    "no-as-unknown-as": noAsUnknownAs,
    "effect-body-must-be-block": effectBodyMustBeBlock,
  },
};
