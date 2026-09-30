export const idFromURL = (url:string):string|null => {
  const id=new URL(url).pathname.match(/\/c\/([^/]+)\/?$/)?.[1];
  if(!id)return null;
  try{return decodeURIComponent(id);}catch{return id;}
};
export const provisionalID = (id:string|null):boolean => !!id && /^(WEB:|local-chatgpt:)/.test(id);
/** New chats transition / -> /c/WEB:<uuid> or /c/local-chatgpt%3A<uuid> -> /c/<durable-id> in the observed UI. */
export class ConversationGuard {
  private permanent:string|null;
  private provisional:string|null;
  private readonly startsNew:boolean;
  constructor(url:string) {
    const id=idFromURL(url);this.startsNew=id===null||provisionalID(id);
    this.permanent=provisionalID(id)?null:id;this.provisional=provisionalID(id)?id:null;
  }
  accept(url:string):boolean {
    const u=new URL(url);
    if(u.origin!=='https://chatgpt.com')return false;
    const id=idFromURL(url);
    if(this.permanent)return id===this.permanent;
    if(!this.startsNew)return false;
    if(id===null)return u.pathname==='/'&&this.provisional===null;
    if(provisionalID(id)) {
      if(!/^(?:WEB:|local-chatgpt:)[a-f0-9-]+$/i.test(id))return false;
      if(this.provisional&&this.provisional!==id)return false;
      this.provisional=id;return true;
    }
    if(!/^[a-zA-Z0-9][a-zA-Z0-9-]{7,127}$/.test(id))return false;
    this.permanent=id;return true;
  }
}
export function isChatSurfaceURL(value:string):boolean {
  try {
    const u=new URL(value);
    return u.origin==='https://chatgpt.com' && (u.pathname==='/' || /^\/c\/[^/]+\/?$/.test(u.pathname) || /^\/g\/[^/]+(?:\/(?:c\/[^/]+|project))?\/?$/.test(u.pathname));
  } catch { return false; }
}
