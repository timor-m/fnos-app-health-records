<script setup lang="ts">
import {computed} from "vue";
import {useRoute,useRouter} from "vue-router";
import {vaccinationReturnTo} from "../../utils/vaccination";
import MemberManager from "../../components/MemberManager.vue";
import SubPageHeader from "../../components/SubPageHeader.vue";
const route=useRoute(),router=useRouter();
const editMember=computed(()=>typeof route.query.editMember==='string'?route.query.editMember:undefined);
const returnTo=computed(()=>vaccinationReturnTo(route.query.returnTo,'/me'));
function saved(id:string){if(id===editMember.value&&returnTo.value!=='/me')void router.push(returnTo.value);}
</script>

<template>
  <section class="settings-page">
    <SubPageHeader :back-to="returnTo" :back-label="returnTo==='/me'?'返回我的':'返回健康历程'" title="家庭成员" description="添加家庭成员并管理自己有权限的成员资料" />
    <MemberManager :edit-member-id="editMember" @saved="saved"/>
  </section>
</template>
