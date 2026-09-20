(() => ({
 url:location.href,
 messages:Array.from(document.querySelectorAll('[data-message-author-role]')).map(e=>({
  attrs:Array.from(e.attributes).filter(a=>a.name!=='class').map(a=>[a.name,a.value]),
  html:e.outerHTML.slice(0,20000),
  ancestors:(()=>{const result=[];let p=e.parentElement;for(let i=0;i<5&&p;i++,p=p.parentElement)result.push({tag:p.tagName,attrs:Array.from(p.attributes).filter(a=>a.name!=='class').map(a=>[a.name,a.value])});return result;})()
 })),
 buttons:Array.from(document.querySelectorAll('main button')).map(e=>({label:e.getAttribute('aria-label'),testid:e.getAttribute('data-testid'),text:e.innerText})),
 turnMarkers:Array.from(document.querySelectorAll('[data-testid*="turn"]')).map(e=>({tag:e.tagName,testid:e.getAttribute('data-testid'),role:e.getAttribute('role')}))
}))()
