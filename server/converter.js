class ArithmeticParser {
  constructor(expression, x) {
    this.expression = expression;
    this.x = x;
    this.index = 0;
  }

  skipWhitespace() {
    while (/\s/.test(this.expression[this.index] || '')) this.index += 1;
  }

  consume(symbol) {
    this.skipWhitespace();
    if (this.expression[this.index] !== symbol) return false;
    this.index += 1;
    return true;
  }

  parse() {
    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.index !== this.expression.length) throw new Error('公式语法无效');
    return value;
  }

  parseExpression() {
    let value = this.parseTerm();
    while (true) {
      if (this.consume('+')) value += this.parseTerm();
      else if (this.consume('-')) value -= this.parseTerm();
      else return value;
    }
  }

  parseTerm() {
    let value = this.parseFactor();
    while (true) {
      if (this.consume('*')) value *= this.parseFactor();
      else if (this.consume('/')) value /= this.parseFactor();
      else return value;
    }
  }

  parseFactor() {
    if (this.consume('+')) return this.parseFactor();
    if (this.consume('-')) return -this.parseFactor();
    if (this.consume('(')) {
      const value = this.parseExpression();
      if (!this.consume(')')) throw new Error('公式括号不匹配');
      return value;
    }

    this.skipWhitespace();
    if ((this.expression[this.index] || '').toLowerCase() === 'x') {
      this.index += 1;
      return this.x;
    }
    const source = this.expression.slice(this.index);
    const number = source.match(/^(?:\d+(?:\.\d*)?|\.\d+)/)?.[0];
    if (!number) throw new Error('公式语法无效');
    this.index += number.length;
    return Number(number);
  }
}

export function normalizeFormula(formula) {
  return String(formula || "x").trim() || "x";
}
export function evaluateFormula(formula, rawValue) {
  const expression = normalizeFormula(formula);
  if (expression.length > 120) throw new Error("转换公式过长");
  if (!/^[0-9xX+\-*/().\s]+$/.test(expression)) {
    throw new Error("公式仅支持 x、数字、括号和四则运算");
  }
  const x = Number(rawValue);
  if (!Number.isFinite(x)) throw new Error("原始余额不是有效数字");
  const value = Number(new ArithmeticParser(expression.toLowerCase(), x).parse());
  if (!Number.isFinite(value)) throw new Error("转换结果无效，请检查除数是否为零");
  if (Math.abs(value) > 1e15) throw new Error("转换结果超出允许范围");
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
