import type { MedicationFormula } from '../../../shared/medication-formula';

export const syntheticFormula: MedicationFormula = {
  kind:'decoction',doseCount:'3',preparation:'合成代煎说明',
  ingredients:['药材甲','药材乙','药材丙','药材丁','药材戊','药材己'].map((name,index)=>({
    name,amount:String(index+6),unit:'g',amountBasis:'per_dose',
    totalAmount:String((index+6)*3),totalUnit:'g',
    instructions:index===0?'合成配制说明':null,
    evidence:[{pageNumber:index<3?1:2,quote:`${name} | ${index+6}g | ${(index+6)*3}g`}],
  })),
};
export function syntheticFormulaPages(page: number) {
  return ['药材调剂单（代煎）','剂数：3','药材 | 每剂用量 | 总量',
    ...syntheticFormula.ingredients.filter(item=>item.evidence[0].pageNumber===page).map(item=>item.evidence[0].quote)];
}
