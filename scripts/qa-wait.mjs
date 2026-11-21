export async function wait(page,predicate,arg,options={}){
  const deadline=Date.now()+(options.timeout??30000);
  while(Date.now()<deadline){if(await page.evaluate(predicate,arg))return;await new Promise(resolve=>setTimeout(resolve,120));}
  throw new Error('The expected desktop state did not arrive before the test deadline.');
}
