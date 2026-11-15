// eval(oldCode) was removed in 1.0
const globalObj = Function("return this")();
const calc = { eval: x => x * 2 };
const label = "evaluate(this)";
chrome.storage.local.get('weather').then(({ weather }) => {
  document.body.append(String(weather?.current?.temperature_2m ?? '?') + ' ' + calc.eval(1) + label + typeof globalObj);
});
