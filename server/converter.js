import { Parser } from "expr-eval";

const parser = new Parser({
  operators: {
    logical: false,
    comparison: false,
    in: false,
    assignment: false,
    factorial: false,
    concatenate: false,
    conditional: false,
  },
});

export function normalizeFormula(formula) {
  return String(formula || "x").trim() || "x";
}
export function evaluateFormula(formula, rawValue) {
  const expression = normalizeFormula(formula);
  if (expression.length > 120) throw new Error("转换公式过长");
  if (!/^[0-9xX+\-*/().\s]+$/.test(expression)) {
    throw new Error("公式仅支持 x、数字、括号和四则运算");
  }
  const parsed = parser.parse(expression.toLowerCase());
  const variables = parsed.variables();
  if (variables.some((variable) => variable !== "x")) {
    throw new Error("公式只能使用变量 x");
  }
  const x = Number(rawValue);
  if (!Number.isFinite(x)) throw new Error("原始余额不是有效数字");
  const value = Number(parsed.evaluate({ x }));
  if (!Number.isFinite(value)) throw new Error("转换结果无效，请检查除数是否为零");
  if (Math.abs(value) > 1e15) throw new Error("转换结果超出允许范围");
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
