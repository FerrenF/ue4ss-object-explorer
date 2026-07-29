/**
 * UE type names collapse into six families that a modder actually reasons
 * about. The table paints rows by family so a 400k-row scroll still reads as
 * structure rather than noise.
 */
export type Family = 'container' | 'callable' | 'numeric' | 'reference' | 'bool' | 'text' | 'other'

const EXACT: Record<string, Family> = {
  Package: 'container',
  Class: 'container',
  BlueprintGeneratedClass: 'container',
  WidgetBlueprintGeneratedClass: 'container',
  AnimBlueprintGeneratedClass: 'container',
  ScriptStruct: 'container',
  Enum: 'container',
  UserDefinedEnum: 'container',
  UserDefinedStruct: 'container',
  Function: 'callable',
  DelegateFunction: 'callable',
  SparseDelegateFunction: 'callable',
  BoolProperty: 'bool',
}

const SUFFIX: [string, Family][] = [
  ['DelegateProperty', 'callable'],
  ['ObjectProperty', 'reference'],
  ['ClassProperty', 'reference'],
  ['StructProperty', 'reference'],
  ['ArrayProperty', 'reference'],
  ['MapProperty', 'reference'],
  ['SetProperty', 'reference'],
  ['InterfaceProperty', 'reference'],
  ['NameProperty', 'text'],
  ['StrProperty', 'text'],
  ['TextProperty', 'text'],
  ['EnumProperty', 'numeric'],
  ['ByteProperty', 'numeric'],
  ['IntProperty', 'numeric'],
  ['Int8Property', 'numeric'],
  ['Int16Property', 'numeric'],
  ['Int64Property', 'numeric'],
  ['UInt16Property', 'numeric'],
  ['UInt32Property', 'numeric'],
  ['UInt64Property', 'numeric'],
  ['FloatProperty', 'numeric'],
  ['DoubleProperty', 'numeric'],
]

const cache = new Map<string, Family>()

export function family(type: string): Family {
  const hit = cache.get(type)
  if (hit) return hit
  let f: Family = EXACT[type] ?? 'other'
  if (f === 'other') {
    for (const [suffix, fam] of SUFFIX) {
      if (type.endsWith(suffix)) {
        f = fam
        break
      }
    }
  }
  if (f === 'other' && type.endsWith('Property')) f = 'reference'
  cache.set(type, f)
  return f
}

export const hue = (type: string) => `var(--t-${family(type)})`

/** UE prefixes every type; the table shows the short form and keeps the rest as a title. */
export function abbreviate(type: string): string {
  if (type.endsWith('Property')) return type.slice(0, -8)
  if (type === 'BlueprintGeneratedClass') return 'BPClass'
  if (type.endsWith('BlueprintGeneratedClass')) return type.slice(0, -22) + 'BPClass'
  if (type === 'SparseDelegateFunction') return 'SparseDlg'
  if (type === 'DelegateFunction') return 'Delegate'
  return type
}
