import type { ServerCart } from '../api/customer';

export type CartProduct = {variantId:string; productId:string; name:string; variantName:string; sellingPaise:string; mrpPaise:string; images:string[]};
export type CartOperation = {
  id:string; variantId:string; delta:number; product?:CartProduct; acceptedPricePaise?:string;
  createdAt?:number;
  request?:{quantity:string;version:number;displayedUnitPricePaise?:string;acceptPriceChange?:boolean};
};
/** Compatible unsent quantity taps on the same variant combine within this window. */
export const CART_COMBINE_WINDOW_MS = 100;
const money = (value:unknown):value is string => typeof value === 'string' && /^(0|[1-9]\d{0,11})$/.test(value);
export function isCartOperation(value:unknown):value is CartOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const action=value as Record<string,unknown>;
  if (typeof action.id !== 'string' || !action.id || typeof action.variantId !== 'string' || !action.variantId ||
    !Number.isSafeInteger(action.delta) || Math.abs(action.delta as number)>1000 ||
    (action.acceptedPricePaise !== undefined && !money(action.acceptedPricePaise)) ||
    (action.createdAt !== undefined && (!Number.isSafeInteger(action.createdAt) || (action.createdAt as number)<0))) return false;
  if (action.product !== undefined) {
    if (!action.product || typeof action.product !== 'object' || Array.isArray(action.product)) return false;
    const product=action.product as Record<string,unknown>;
    if (product.variantId !== action.variantId || typeof product.productId !== 'string' ||
      typeof product.name !== 'string' || typeof product.variantName !== 'string' || !money(product.sellingPaise) ||
      !money(product.mrpPaise) || !Array.isArray(product.images) || !product.images.every(image => typeof image === 'string')) return false;
  }
  if (action.request !== undefined) {
    if (!action.request || typeof action.request !== 'object' || Array.isArray(action.request)) return false;
    const request=action.request as Record<string,unknown>;
    if (!money(request.quantity) || !Number.isSafeInteger(request.version) || (request.version as number)<1 ||
      (request.displayedUnitPricePaise !== undefined && !money(request.displayedUnitPricePaise)) ||
      (request.acceptPriceChange !== undefined && typeof request.acceptPriceChange !== 'boolean')) return false;
  }
  return true;
}

/** Render pending taps on top of the most recent authoritative server cart. */
export function projectCart(confirmed:ServerCart | null, actions:CartOperation[], userId:string):ServerCart | null {
  if (!confirmed && actions.length === 0) return null;
  const cart:ServerCart = confirmed ? {...confirmed, lines:confirmed.lines.map(line => ({...line}))} :
    {cartId:'',userId,storeId:null,addressId:null,version:1,couponCode:null,lines:[],issues:[]};
  for (const action of actions) {
    // A request restored after a timeout may already be reflected in the server cart.
    // Its idempotent replay settles that uncertainty; do not show the same tap twice.
    if (action.request && confirmed && confirmed.version > action.request.version) continue;
    const index = cart.lines.findIndex(line => line.variantId === action.variantId);
    const old = index < 0 ? 0 : Number(cart.lines[index].quantity);
    const quantity = Math.max(0, old + action.delta);
    if (index >= 0 && quantity === 0) cart.lines.splice(index,1);
    else if (index >= 0) {
      const line = cart.lines[index];
      cart.lines[index] = {...line,quantity:String(quantity),lineSubtotalPaise:(BigInt(line.unitPricePaise) * BigInt(quantity)).toString()};
    } else if (quantity > 0 && action.product) {
      const item=action.product;
      cart.lines.push({variantId:item.variantId,productId:item.productId,productName:item.name,variantName:item.variantName,image:item.images[0] ?? null,quantity:String(quantity),unitPricePaise:item.sellingPaise,currentUnitPricePaise:item.sellingPaise,mrpPaise:item.mrpPaise,lineSubtotalPaise:(BigInt(item.sellingPaise)*BigInt(quantity)).toString()});
    }
  }
  return cart;
}

/** Merge only adjacent unsent quantity taps inside the combine window; requests that may have reached the server are immutable. */
export function appendCartOperation(confirmed:ServerCart | null, actions:CartOperation[], userId:string, next:CartOperation, now:number = Date.now()):CartOperation[] {
  const previous=actions[actions.length-1];
  const previousAt=previous?.createdAt ?? 0;
  const nextAt=next.createdAt ?? now;
  if (!previous || previous.request || previous.variantId !== next.variantId || !previous.delta || !next.delta ||
    previous.createdAt === undefined || nextAt-previousAt > CART_COMBINE_WINDOW_MS ||
    previous.acceptedPricePaise !== undefined || next.acceptedPricePaise !== undefined ||
    (previous.product && next.product && (previous.product.sellingPaise !== next.product.sellingPaise || previous.product.mrpPaise !== next.product.mrpPaise)))
    return [...actions,next];
  const earlier=actions.slice(0,-1);
  const base=Number(projectCart(confirmed,earlier,userId)?.lines.find(line => line.variantId === next.variantId)?.quantity ?? 0);
  const afterPrevious=Math.max(0,base+previous.delta);
  const merged=Math.max(0,afterPrevious+next.delta)-base;
  if (!merged) return earlier;
  return [...earlier,{...previous,delta:merged,product:previous.product ?? next.product}];
}

/**
 * Undo the most recent never-sent operation for a variant. Returns the new
 * action list, or null when nothing is undoable. Sent or uncertain operations
 * (those with a request) are immutable: undoing those needs an opposite tap,
 * which the stepper still provides.
 */
export function undoCartOperation(actions:CartOperation[], variantId:string):CartOperation[] | null {
  let index = -1;
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].variantId === variantId && !actions[i].request) { index = i; break; }
  }
  if (index < 0) return null;
  const target = actions[index];
  const unit = target.delta === 0 ? 0 : target.delta > 0 ? 1 : -1;
  const delta = target.delta - unit;
  if (!delta) return [...actions.slice(0, index), ...actions.slice(index + 1)];
  return [...actions.slice(0, index), { ...target, delta }, ...actions.slice(index + 1)];
}
