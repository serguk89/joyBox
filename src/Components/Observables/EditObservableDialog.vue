<template>
  <v-dialog :value="show" @input="Close" width="500">
    <v-card class="dlg">
      <v-card-title class="title font-weight-medium justify-center">{{target}}</v-card-title>
      <v-list dense nav>
        <v-subheader class="font-weight-regular justify-center">Plugin precedence</v-subheader>
        <draggable @update="ReorderObservablePlugin(target, $event)" :disabled="Access.NonFullAccess">
          <v-list-item v-for="plugin in Plugins" :key="plugin.name">
            <v-list-item-content>
              <v-list-item-title :class="{'grey--text': !plugin.enabled}">{{plugin.name}}</v-list-item-title>
              <v-list-item-subtitle v-if="ActivePlugin === plugin">active</v-list-item-subtitle>
            </v-list-item-content>
          </v-list-item>
        </draggable>
      </v-list>
      <v-btn @click="Remove" class="red--text" :disabled="Access.NonFullAccess">Remove</v-btn>
      <v-btn @click="Close">Close</v-btn>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.dlg {
  padding: 10px;
}
</style>

<script lang="ts">
import 'reflect-metadata';

import { Component, Emit, Mixins, Model, Prop, Vue } from 'vue-property-decorator';
import draggable, { UpdateEvent } from 'vuedraggable';

import RefsForwarding from '@/Mixins/RefsForwarding';
import { Plugin, Stream } from '@/types';

@Component({
  components: {
    draggable
  }
})
export default class EditObservableDialog extends Mixins(RefsForwarding) {
  @Model('change') private show: boolean = false;
  @Prop({ default: '' }) private readonly target!: string;
  @Emit() private Change(show: boolean) { }

  private get Plugins(): Plugin[] {
    const stream: Stream | undefined = this.App.observables.find((o: Stream) => o.uri === this.target);
    return stream ? stream.plugins : [];
  }
  private Close() {
    this.Change(false);
  }

  // TODO Откатывать в состояние до перетаскивания в случае ошибки
  private ReorderObservablePlugin(uri: string, evt: UpdateEvent<Event>) {
    this.$rpc.ReorderObservablePlugin(uri, evt.oldIndex, evt.newIndex);
  }

  private get ActivePlugin(): Plugin | null {
    return this.Plugins.find(x => x.enabled) || null;
  }

  private async Remove() {
    await this.$rpc.RemoveObservable(this.target);
    this.Close();
  }
}
</script>
